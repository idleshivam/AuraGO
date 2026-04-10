from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from backend.data import get_routes
from backend.safety import calculate_route_safety, detect_risks, get_safety_explanation, label_segment
import os

app = Flask(__name__)
CORS(app)

# Path to the frontend folder (one level up from backend/)
FRONTEND_DIR = os.path.join(os.path.dirname(__file__), '..', 'frontend')

# ── Serve frontend ──────────────────────────────────────────────
@app.route("/")
def index():
    return send_from_directory(FRONTEND_DIR, 'index.html')

@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(FRONTEND_DIR, filename)

# ── Routes API ──────────────────────────────────────────────────
@app.route("/routes", methods=["POST"])
def routes():
    data = request.json
    source      = data.get("source")
    destination = data.get("destination")
    women_mode  = bool(data.get("women_mode", False))   # ← new flag

    routes = get_routes(source, destination)

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
