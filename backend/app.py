from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from backend.data import get_routes
from backend.safety import calculate_route_safety, detect_risks, get_safety_explanation, label_segment
from werkzeug.security import generate_password_hash, check_password_hash
import os
import sqlite3
import secrets
from datetime import datetime

app = Flask(__name__)
CORS(app)

# ── Database setup ──────────────────────────────────────────────
DB_PATH = os.path.join(os.path.dirname(__file__), 'users.db')

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    with get_db() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                name      TEXT    NOT NULL,
                email     TEXT    NOT NULL UNIQUE,
                password  TEXT    NOT NULL,
                token     TEXT,
                created_at TEXT   DEFAULT CURRENT_TIMESTAMP
            )
        ''')
        conn.commit()

init_db()

# Path to the frontend folder (one level up from backend/)
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), '..', 'frontend')

# ── Serve frontend ──────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, 'index.html')

@app.route("/login")
def login_page():
    return send_from_directory(FRONTEND_DIR, 'login.html')

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(FRONTEND_DIR, filename)

# ── Auth helpers ───────────────────────────────────────────────
def get_user_by_token(token):
    if not token:
        return None
    with get_db() as conn:
        return conn.execute('SELECT * FROM users WHERE token = ?', (token,)).fetchone()

# ── Auth endpoints ──────────────────────────────────────────────
@app.route('/auth/register', methods=['POST'])
def register():
    data     = request.get_json()
    name     = (data.get('name') or '').strip()
    email    = (data.get('email') or '').strip().lower()
    password = (data.get('password') or '').strip()

    if not name or not email or not password:
        return jsonify({'error': 'All fields are required.'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters.'}), 400

    hashed = generate_password_hash(password)
    token  = secrets.token_hex(32)
    try:
        with get_db() as conn:
            conn.execute(
                'INSERT INTO users (name, email, password, token) VALUES (?, ?, ?, ?)',
                (name, email, hashed, token)
            )
            conn.commit()
    except sqlite3.IntegrityError:
        return jsonify({'error': 'An account with this email already exists.'}), 409

    return jsonify({'token': token, 'name': name, 'email': email}), 201


@app.route('/auth/login', methods=['POST'])
def login():
    data     = request.get_json()
    email    = (data.get('email') or '').strip().lower()
    password = (data.get('password') or '').strip()

    if not email or not password:
        return jsonify({'error': 'Email and password are required.'}), 400

    with get_db() as conn:
        user = conn.execute('SELECT * FROM users WHERE email = ?', (email,)).fetchone()

    if not user or not check_password_hash(user['password'], password):
        return jsonify({'error': 'Invalid email or password.'}), 401

    # Rotate token on each login
    token = secrets.token_hex(32)
    with get_db() as conn:
        conn.execute('UPDATE users SET token = ? WHERE id = ?', (token, user['id']))
        conn.commit()

    return jsonify({'token': token, 'name': user['name'], 'email': user['email']}), 200


@app.route('/auth/me', methods=['GET'])
def me():
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    user  = get_user_by_token(token)
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401
    return jsonify({'name': user['name'], 'email': user['email']}), 200


@app.route('/auth/logout', methods=['POST'])
def logout():
    token = request.headers.get('Authorization', '').replace('Bearer ', '')
    if token:
        with get_db() as conn:
            conn.execute('UPDATE users SET token = NULL WHERE token = ?', (token,))
            conn.commit()
    return jsonify({'ok': True}), 200


# ── Routes API ──────────────────────────────────────────────────
@app.route("/routes", methods=["POST"])
def routes():
    data = request.json
    source        = data.get("source")
    destination   = data.get("destination")
    women_mode    = bool(data.get("women_mode", False))
    routes_coords = data.get("routes_coords", [])   # actual OSRM polylines

    routes = get_routes(source, destination, routes_coords=routes_coords)

    for route in routes:
        route["safety_score"] = calculate_route_safety(
            route["segments"], women_mode=women_mode
        )
        route["risks"]        = detect_risks(
            route["segments"], women_mode=women_mode
        )
        route["segment_labels"] = [
            label_segment(s, women_mode=women_mode) for s in route["segments"]
        ]
        route["explanation"]  = get_safety_explanation(
            route, women_mode=women_mode
        )

    # Sort safest first
    routes = sorted(routes, key=lambda x: x["safety_score"], reverse=True)

    return jsonify(routes)

#porting the webpage
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
