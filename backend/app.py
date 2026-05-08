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
        # ── Users table (with emergency contact fields) ────────
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id                      INTEGER PRIMARY KEY AUTOINCREMENT,
                name                    TEXT    NOT NULL,
                email                   TEXT    NOT NULL UNIQUE,
                phone                   TEXT    DEFAULT '',
                password                TEXT    NOT NULL,
                emergency_contact_name  TEXT    DEFAULT '',
                emergency_contact_phone TEXT    DEFAULT '',
                relationship            TEXT    DEFAULT '',
                token                   TEXT,
                created_at              TEXT    DEFAULT CURRENT_TIMESTAMP
            )
        ''')

        # ── Migrate: add columns if they don't exist (for existing DBs) ──
        existing = [row[1] for row in conn.execute('PRAGMA table_info(users)').fetchall()]
        migrations = {
            'phone':                   "ALTER TABLE users ADD COLUMN phone TEXT DEFAULT ''",
            'emergency_contact_name':  "ALTER TABLE users ADD COLUMN emergency_contact_name TEXT DEFAULT ''",
            'emergency_contact_phone': "ALTER TABLE users ADD COLUMN emergency_contact_phone TEXT DEFAULT ''",
            'relationship':            "ALTER TABLE users ADD COLUMN relationship TEXT DEFAULT ''",
        }
        for col, sql in migrations.items():
            if col not in existing:
                conn.execute(sql)

        # ── Community incident reports table ───────────────────
        conn.execute('''
            CREATE TABLE IF NOT EXISTS reports (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id     INTEGER,
                category    TEXT    NOT NULL,
                description TEXT    DEFAULT '',
                latitude    REAL    NOT NULL,
                longitude   REAL    NOT NULL,
                created_at  TEXT    DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (user_id) REFERENCES users(id)
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

def extract_token():
    return request.headers.get('Authorization', '').replace('Bearer ', '')

# ══════════════════════════════════════════════════════════════════
#  AUTH ENDPOINTS
# ══════════════════════════════════════════════════════════════════

@app.route('/auth/register', methods=['POST'])
def register():
    data = request.get_json()
    name     = (data.get('name') or '').strip()
    email    = (data.get('email') or '').strip().lower()
    phone    = (data.get('phone') or '').strip()
    password = (data.get('password') or '').strip()
    ec_name  = (data.get('emergency_contact_name') or '').strip()
    ec_phone = (data.get('emergency_contact_phone') or '').strip()
    ec_rel   = (data.get('relationship') or '').strip()

    if not name or not email or not password:
        return jsonify({'error': 'Name, email, and password are required.'}), 400
    if len(password) < 6:
        return jsonify({'error': 'Password must be at least 6 characters.'}), 400
    if not ec_name or not ec_phone:
        return jsonify({'error': 'Emergency contact name and phone are required.'}), 400

    hashed = generate_password_hash(password)
    token  = secrets.token_hex(32)
    try:
        with get_db() as conn:
            conn.execute(
                '''INSERT INTO users
                   (name, email, phone, password, emergency_contact_name,
                    emergency_contact_phone, relationship, token)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)''',
                (name, email, phone, hashed, ec_name, ec_phone, ec_rel, token)
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
    token = extract_token()
    user  = get_user_by_token(token)
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401
    return jsonify({
        'name': user['name'],
        'email': user['email'],
        'phone': user['phone'] or '',
        'emergency_contact_name':  user['emergency_contact_name'] or '',
        'emergency_contact_phone': user['emergency_contact_phone'] or '',
        'relationship':            user['relationship'] or '',
    }), 200


@app.route('/auth/logout', methods=['POST'])
def logout():
    token = extract_token()
    if token:
        with get_db() as conn:
            conn.execute('UPDATE users SET token = NULL WHERE token = ?', (token,))
            conn.commit()
    return jsonify({'ok': True}), 200


# ══════════════════════════════════════════════════════════════════
#  EMERGENCY CONTACT — retrieve for SOS escalation
# ══════════════════════════════════════════════════════════════════

@app.route('/auth/emergency-contact', methods=['GET'])
def get_emergency_contact():
    """Return the authenticated user's emergency contact info for SOS."""
    token = extract_token()
    user  = get_user_by_token(token)
    if not user:
        return jsonify({'error': 'Unauthorized'}), 401

    return jsonify({
        'user_name':  user['name'],
        'user_phone': user['phone'] or '',
        'emergency_contact_name':  user['emergency_contact_name'] or '',
        'emergency_contact_phone': user['emergency_contact_phone'] or '',
        'relationship':            user['relationship'] or '',
    }), 200


# ══════════════════════════════════════════════════════════════════
#  COMMUNITY INCIDENT REPORTS
# ══════════════════════════════════════════════════════════════════

VALID_CATEGORIES = [
    'harassment', 'poor_lighting', 'suspicious_activity',
    'accident', 'unsafe_crowd', 'roadblock', 'other'
]

@app.route('/report', methods=['POST'])
def create_report():
    """Submit a new incident report at a map location."""
    token = extract_token()
    user  = get_user_by_token(token)
    if not user:
        return jsonify({'error': 'Unauthorized. Please sign in to report.'}), 401

    data = request.get_json()
    category    = (data.get('category') or '').strip().lower()
    description = (data.get('description') or '').strip()
    lat         = data.get('latitude')
    lon         = data.get('longitude')

    if category not in VALID_CATEGORIES:
        return jsonify({'error': f'Invalid category. Choose from: {", ".join(VALID_CATEGORIES)}'}), 400
    if lat is None or lon is None:
        return jsonify({'error': 'Location (latitude, longitude) is required.'}), 400

    with get_db() as conn:
        conn.execute(
            '''INSERT INTO reports (user_id, category, description, latitude, longitude)
               VALUES (?, ?, ?, ?, ?)''',
            (user['id'], category, description, lat, lon)
        )
        conn.commit()

    return jsonify({'ok': True, 'message': 'Report submitted. Thank you for helping keep the community safe!'}), 201


@app.route('/reports', methods=['GET'])
def get_reports():
    """Fetch recent incident reports within a bounding box (or all recent)."""
    # Optional bbox filtering
    south = request.args.get('south', type=float)
    north = request.args.get('north', type=float)
    west  = request.args.get('west', type=float)
    east  = request.args.get('east', type=float)

    with get_db() as conn:
        if all(v is not None for v in [south, north, west, east]):
            rows = conn.execute(
                '''SELECT id, category, description, latitude, longitude, created_at
                   FROM reports
                   WHERE latitude BETWEEN ? AND ?
                     AND longitude BETWEEN ? AND ?
                   ORDER BY created_at DESC
                   LIMIT 100''',
                (south, north, west, east)
            ).fetchall()
        else:
            rows = conn.execute(
                '''SELECT id, category, description, latitude, longitude, created_at
                   FROM reports
                   ORDER BY created_at DESC
                   LIMIT 100'''
            ).fetchall()

    reports = [
        {
            'id': r['id'],
            'category': r['category'],
            'description': r['description'],
            'latitude': r['latitude'],
            'longitude': r['longitude'],
            'created_at': r['created_at'],
        }
        for r in rows
    ]

    return jsonify(reports), 200


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
