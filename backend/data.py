import random
from datetime import datetime


def generate_segment(profile="normal"):
    """
    Generate a road segment with safety data based on route profile.
    profile = 'busy' (market area/main road), 'normal', or 'isolated' (back lanes)
    """
    current_hour = datetime.now().hour
    is_night = current_hour >= 22 or current_hour <= 5

    if profile == "busy":
        # Main road, market area, high foot traffic
        crowd    = random.randint(65, 95)
        lighting = random.randint(70, 95)
        activity = random.randint(70, 95) if not is_night else random.randint(40, 70)
    elif profile == "isolated":
        # Back lane, empty side streets, poor lighting
        crowd    = random.randint(5,  30)
        lighting = random.randint(15, 50)
        activity = random.randint(5,  30) if is_night else random.randint(10, 40)
    else:
        # Normal residential / semi-busy road
        crowd    = random.randint(30, 65)
        lighting = random.randint(45, 75)
        activity = random.randint(35, 65) if not is_night else random.randint(15, 45)

    return {
        "crowd":    crowd,
        "lighting": lighting,
        "activity": activity
    }


def get_routes(source, destination):
    """
    Returns three route profiles with distinct safety characteristics
    so the comparison is meaningful.
    """
    return [
        {
            "name":     "Route A – Main Road",
            "distance": "5.4 km",
            "eta":      "16 min",
            "coords":   [],   # actual coords come from OSRM on frontend
            "segments": [generate_segment("busy") for _ in range(6)]
        },
        {
            "name":     "Route B – Mixed Streets",
            "distance": "4.2 km",
            "eta":      "13 min",
            "coords":   [],
            "segments": [generate_segment("normal") for _ in range(6)]
        },
        {
            "name":     "Route C – Back Lanes",
            "distance": "3.5 km",
            "eta":      "11 min",
            "coords":   [],
            "segments": [generate_segment("isolated") for _ in range(6)]
        }
    ]