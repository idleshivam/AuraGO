import random
from datetime import datetime

def generate_segment():
    current_hour = datetime.now().hour

    # Simulate night vs day behavior
    if current_hour >= 22 or current_hour <= 5:
        crowd = random.randint(5, 50)        # low at night
        lighting = random.randint(20, 70)
        activity = random.randint(5, 40)
    else:
        crowd = random.randint(30, 90)
        lighting = random.randint(50, 90)
        activity = random.randint(40, 90)

    return {
        "crowd": crowd,
        "lighting": lighting,
        "activity": activity
    }

def get_routes(source, destination):
    return [
        {
            "name": "Route A",
            "distance": "5 km",
            "segments": [generate_segment() for _ in range(5)]
        },
        {
            "name": "Route B",
            "distance": "6 km",
            "segments": [generate_segment() for _ in range(5)]
        }
    ]