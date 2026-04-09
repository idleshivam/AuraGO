from flask import Flask, request, jsonify
from flask_cors import CORS
from data import get_routes
from safety import calculate_route_safety, detect_risks

app = Flask(__name__)
CORS(app)

@app.route("/")
def home():
    return {"message": "SafeRoute AI Backend Running"}

@app.route("/routes", methods=["POST"])
def routes():
    data = request.json
    source = data.get("source")
    destination = data.get("destination")

    routes = get_routes(source, destination)

    for route in routes:
        route["safety_score"] = calculate_route_safety(route["segments"])
        route["risks"] = detect_risks(route["segments"])

    # Sort by safest
    routes = sorted(routes, key=lambda x: x["safety_score"], reverse=True)

    return jsonify(routes)

if __name__ == "__main__":
    app.run(debug=True)