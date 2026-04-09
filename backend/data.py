import random

def get_routes(source, destination):
    # Simulated routes
    return [
        {
            "name": "Route A",
            "distance": "5 km",
            "crowd": random.randint(10, 40),   # low crowd
            "lighting": random.randint(20, 50),
            "activity": random.randint(10, 40)
        },
        {
            "name": "Route B",
            "distance": "6 km",
            "crowd": random.randint(60, 90),   # good crowd
            "lighting": random.randint(60, 90),
            "activity": random.randint(60, 90)
        }
    ]