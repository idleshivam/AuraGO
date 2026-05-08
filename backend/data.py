"""
AuraGO — Real-Time Geospatial Safety Intelligence Engine
=========================================================
Replaces random safety data with live urban-signal analysis:
  • ONE batched Overpass API query per route (POIs + streetlights + roads)
  • Local segment-level scoring via Haversine proximity mapping
  • In-memory TTL cache (10 min) to prevent redundant API calls
  • Graceful fallback to time-of-day + road-profile heuristics
"""

import math
import time
import requests
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor

# ═══════════════════════════════════════════════════════════════════
#  IN-MEMORY CACHE (TTL = 10 minutes)
# ═══════════════════════════════════════════════════════════════════
_cache = {}
CACHE_TTL = 600  # seconds

def _cache_get(key):
    entry = _cache.get(key)
    if entry and (time.time() - entry["ts"]) < CACHE_TTL:
        return entry["data"]
    return None

def _cache_set(key, data):
    _cache[key] = {"data": data, "ts": time.time()}


# ═══════════════════════════════════════════════════════════════════
#  HAVERSINE DISTANCE (metres)
# ═══════════════════════════════════════════════════════════════════
def _haversine(lat1, lon1, lat2, lon2):
    """Return distance in metres between two lat/lon points."""
    R = 6_371_000  # Earth radius in metres
    φ1, φ2 = math.radians(lat1), math.radians(lat2)
    Δφ = math.radians(lat2 - lat1)
    Δλ = math.radians(lon2 - lon1)
    a = math.sin(Δφ / 2) ** 2 + math.cos(φ1) * math.cos(φ2) * math.sin(Δλ / 2) ** 2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


# ═══════════════════════════════════════════════════════════════════
#  ROUTE SAMPLING — pick N evenly-spaced points along polyline
# ═══════════════════════════════════════════════════════════════════
def _sample_route_points(coords, n=6):
    """
    Sample `n` evenly-spaced points from a coordinate list.
    coords = [[lat, lon], ...] or [(lat, lon), ...]
    """
    if not coords or len(coords) < 2:
        return coords or []
    total = len(coords)
    if total <= n:
        return [list(c) for c in coords]
    step = (total - 1) / (n - 1)
    return [list(coords[round(i * step)]) for i in range(n)]


# ═══════════════════════════════════════════════════════════════════
#  OVERPASS API — SINGLE BATCHED QUERY
# ═══════════════════════════════════════════════════════════════════
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
OVERPASS_TIMEOUT = 10  # seconds

def _build_bbox(all_coords, pad=0.008):
    """Build a (south, west, north, east) bounding box with padding."""
    lats = [c[0] for c in all_coords]
    lons = [c[1] for c in all_coords]
    return (
        min(lats) - pad,
        min(lons) - pad,
        max(lats) + pad,
        max(lons) + pad,
    )

def _fetch_overpass(bbox):
    """
    Single batched query: fetch amenities, streetlights, and road types
    within the bounding box.  Returns dict with 'pois', 'lamps', 'roads'.
    """
    s, w, n, e = bbox
    bbox_str = f"{s},{w},{n},{e}"
    cache_key = f"overpass_{round(s,3)}_{round(w,3)}_{round(n,3)}_{round(e,3)}"

    cached = _cache_get(cache_key)
    if cached is not None:
        return cached

    query = f"""[out:json][timeout:{OVERPASS_TIMEOUT}];
(
  node["amenity"~"restaurant|cafe|bar|shop|supermarket|school|hospital|clinic|bank|pharmacy|bus_station|fuel|marketplace|theatre|cinema|place_of_worship|police"]({bbox_str});
  node["shop"]({bbox_str});
  node["highway"="street_lamp"]({bbox_str});
  way["highway"~"trunk|primary|secondary|tertiary|residential|service|unclassified"]({bbox_str});
);
out center;"""

    try:
        resp = requests.post(
            OVERPASS_URL,
            data={"data": query},
            headers={
                "User-Agent": "AuraGO-SafetyApp/1.0",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout=OVERPASS_TIMEOUT + 2,
        )
        resp.raise_for_status()
        elements = resp.json().get("elements", [])
    except Exception:
        _cache_set(cache_key, None)
        return None

    # Classify elements
    pois  = []
    lamps = []
    roads = []

    for el in elements:
        tags = el.get("tags", {})

        if el["type"] == "node":
            lat, lon = el.get("lat"), el.get("lon")
            if lat is None or lon is None:
                continue

            if tags.get("highway") == "street_lamp":
                lamps.append({"lat": lat, "lon": lon})
            elif tags.get("amenity") or tags.get("shop"):
                poi_type = tags.get("amenity") or tags.get("shop", "other")
                pois.append({"lat": lat, "lon": lon, "type": poi_type})

        elif el["type"] == "way" and tags.get("highway"):
            road_class = tags["highway"]
            # Use the first node's coordinates as a rough position for the way
            # (we'll match by proximity anyway)
            center = el.get("center")
            if center:
                roads.append({"lat": center["lat"], "lon": center["lon"], "class": road_class})
            elif el.get("nodes"):
                # We'll resolve nodes later; for now store the classification
                roads.append({"class": road_class, "nodes": el.get("nodes", [])})

    result = {"pois": pois, "lamps": lamps, "roads": roads}
    _cache_set(cache_key, result)
    return result


# ═══════════════════════════════════════════════════════════════════
#  LOCAL SEGMENT ANALYSIS — no additional API calls
# ═══════════════════════════════════════════════════════════════════
NIGHTLIFE_TYPES = {"restaurant", "cafe", "bar", "pub", "nightclub", "theatre", "cinema"}

ROAD_RANK = {
    "trunk": 90, "primary": 80, "secondary": 65,
    "tertiary": 50, "unclassified": 35,
    "residential": 28, "service": 15,
}


def _count_nearby(items, lat, lon, radius_m):
    """Count items within `radius_m` metres of (lat, lon)."""
    return sum(
        1 for it in items
        if "lat" in it and "lon" in it
        and _haversine(lat, lon, it["lat"], it["lon"]) <= radius_m
    )


def _nearby_items(items, lat, lon, radius_m):
    """Return items within `radius_m` metres of (lat, lon)."""
    return [
        it for it in items
        if "lat" in it and "lon" in it
        and _haversine(lat, lon, it["lat"], it["lon"]) <= radius_m
    ]


def _best_road_class(roads, lat, lon, radius_m=400):
    """Find the highest-ranked road classification near (lat, lon)."""
    best_rank = 10  # default: very minor road
    for rd in roads:
        if "lat" in rd and "lon" in rd:
            if _haversine(lat, lon, rd["lat"], rd["lon"]) <= radius_m:
                best_rank = max(best_rank, ROAD_RANK.get(rd["class"], 10))
        elif "class" in rd:
            # Way without resolved coordinates — use classification as-is
            best_rank = max(best_rank, ROAD_RANK.get(rd["class"], 10))
    return best_rank


def _compute_crowd(pois, lat, lon, radius_m=300):
    """POI density → crowd proxy score (0–100)."""
    count = _count_nearby(pois, lat, lon, radius_m)
    if count >= 15:
        return min(85 + count, 98)
    elif count >= 8:
        return 55 + count * 2
    elif count >= 3:
        return 30 + count * 4
    elif count >= 1:
        return 15 + count * 8
    else:
        return 8


def _compute_lighting(lamps, lat, lon, hour, radius_m=200):
    """Streetlight density + time-of-day → lighting score (0–100)."""
    # Time-of-day base
    if 7 <= hour <= 18:
        time_base = 80
    elif 6 <= hour <= 7 or 18 < hour <= 19:
        time_base = 55
    elif 19 < hour <= 21:
        time_base = 35
    else:
        time_base = 18

    # Infrastructure bonus from streetlights
    lamp_count = _count_nearby(lamps, lat, lon, radius_m)
    infra_bonus = min(lamp_count * 4, 30)

    return min(time_base + infra_bonus, 95)


def _compute_activity(pois, roads, lat, lon, hour, radius_m=300):
    """Road classification + POI mix + time → activity score (0–100)."""
    road_base = _best_road_class(roads, lat, lon, radius_m + 100)
    is_night = hour >= 22 or hour <= 5

    nearby_pois = _nearby_items(pois, lat, lon, radius_m)
    nightlife_count = sum(1 for p in nearby_pois if p.get("type") in NIGHTLIFE_TYPES)
    total_pois = len(nearby_pois)

    if is_night:
        # Nightlife POIs keep activity high at night
        night_boost = min(nightlife_count * 6, 30)
        activity = max(int(road_base * 0.45) + night_boost, 8)
    else:
        # Daytime: road type + general POI density
        poi_boost = min(total_pois * 2, 20)
        activity = min(road_base + poi_boost, 95)

    return activity


def _analyze_segment(lat, lon, overpass_data, hour):
    """Combine all signals into a single segment dict."""
    pois  = overpass_data["pois"]
    lamps = overpass_data["lamps"]
    roads = overpass_data["roads"]

    return {
        "crowd":    _compute_crowd(pois, lat, lon),
        "lighting": _compute_lighting(lamps, lat, lon, hour),
        "activity": _compute_activity(pois, roads, lat, lon, hour),
    }


# ═══════════════════════════════════════════════════════════════════
#  FALLBACK HEURISTICS — used when APIs are unavailable
# ═══════════════════════════════════════════════════════════════════
def _fallback_segment(seg_index, total_segments, hour):
    """
    Sensible estimate when Overpass is down.
    Distributes segments across busy → mixed → isolated profiles
    based on position in the route (start/end near populated areas,
    middle segments may be quieter).
    """
    is_night = hour >= 22 or hour <= 5
    is_twilight = 19 <= hour <= 22 or 5 <= hour <= 7

    # Edge segments (near source/destination) tend to be busier
    position_ratio = seg_index / max(total_segments - 1, 1)
    edge_dist = min(position_ratio, 1 - position_ratio)  # 0 at edges, 0.5 at center

    if edge_dist < 0.2:
        # Near start/end — likely populated area
        crowd = 65
        lighting = 75 if not is_night else (45 if is_twilight else 35)
        activity = 70 if not is_night else 45
    elif edge_dist < 0.4:
        # Mid-route — mixed
        crowd = 42
        lighting = 60 if not is_night else (35 if is_twilight else 25)
        activity = 50 if not is_night else 30
    else:
        # Center of route — potentially quieter
        crowd = 25
        lighting = 50 if not is_night else (28 if is_twilight else 18)
        activity = 35 if not is_night else 18

    return {"crowd": crowd, "lighting": lighting, "activity": activity}


# ═══════════════════════════════════════════════════════════════════
#  MAIN ENTRY POINT — analyse a full route
# ═══════════════════════════════════════════════════════════════════
def analyze_route(coords):
    """
    Analyse a single route's safety using real geospatial data.

    Parameters
    ----------
    coords : list of [lat, lon]  — full polyline from OSRM

    Returns
    -------
    dict: {
        "segments": [ {crowd, lighting, activity}, ... ],
        "metadata": { data_sources, confidence, analysis_mode, cache_hit, query_time_ms }
    }
    """
    t_start = time.time()
    hour = datetime.now().hour
    sample_points = _sample_route_points(coords, n=6)

    if not sample_points:
        return {
            "segments": [_fallback_segment(i, 6, hour) for i in range(6)],
            "metadata": _meta("heuristic", False, t_start, "estimated"),
        }

    # Build bounding box from ALL route coords (not just samples)
    bbox = _build_bbox(coords)
    cache_key = f"overpass_{round(bbox[0],3)}_{round(bbox[1],3)}_{round(bbox[2],3)}_{round(bbox[3],3)}"
    cache_hit = _cache_get(cache_key) is not None

    # Single batched Overpass query
    overpass_data = _fetch_overpass(bbox)

    if overpass_data is None:
        # API failed → graceful fallback
        segments = [_fallback_segment(i, len(sample_points), hour) for i in range(len(sample_points))]
        return {
            "segments": segments,
            "metadata": _meta("heuristic", False, t_start, "estimated"),
        }

    # Local segment analysis — no more API calls
    segments = [
        _analyze_segment(pt[0], pt[1], overpass_data, hour)
        for pt in sample_points
    ]

    return {
        "segments": segments,
        "metadata": _meta("live", cache_hit, t_start, "high"),
    }


def _meta(mode, cache_hit, t_start, confidence):
    """Build explainability metadata dict."""
    sources = {
        "live": [
            "OSM POI density",
            "road classification",
            "streetlight infrastructure",
            "time-of-day model",
        ],
        "heuristic": [
            "time-of-day model",
            "route profile heuristic",
        ],
    }
    return {
        "data_sources":  sources.get(mode, sources["heuristic"]),
        "confidence":    confidence,
        "analysis_mode": mode,
        "cache_hit":     cache_hit,
        "query_time_ms": round((time.time() - t_start) * 1000),
    }


# ═══════════════════════════════════════════════════════════════════
#  COMPATIBILITY WRAPPER — called by app.py
# ═══════════════════════════════════════════════════════════════════
def get_routes(source, destination, routes_coords=None):
    """
    Analyse up to 3 routes.

    Parameters
    ----------
    source       : str   — source place name (for route labeling)
    destination  : str   — destination place name
    routes_coords: list  — [ [[lat,lon], ...], [[lat,lon], ...], ... ]
                           actual polyline coords from OSRM (sent by frontend)

    Returns
    -------
    list of route dicts compatible with safety.py
    """
    route_names = [
        "Route A – Main Road",
        "Route B – Mixed Streets",
        "Route C – Back Lanes",
    ]

    if not routes_coords or not any(routes_coords):
        # No coordinates provided — pure fallback
        hour = datetime.now().hour
        profiles = ["busy", "normal", "isolated"]
        results = []
        for i, profile in enumerate(profiles):
            segs = [_fallback_segment(j, 6, hour) for j in range(6)]
            results.append({
                "name":     route_names[i] if i < len(route_names) else f"Route {chr(65+i)}",
                "distance": "—",
                "eta":      "—",
                "coords":   [],
                "segments": segs,
                "metadata": _meta("heuristic", False, time.time(), "estimated"),
            })
        return results

    results = []
    for i, coords in enumerate(routes_coords[:3]):
        if not coords or len(coords) < 2:
            hour = datetime.now().hour
            segs = [_fallback_segment(j, 6, hour) for j in range(6)]
            analysis = {
                "segments": segs,
                "metadata": _meta("heuristic", False, time.time(), "estimated"),
            }
        else:
            analysis = analyze_route(coords)

        results.append({
            "name":     route_names[i] if i < len(route_names) else f"Route {chr(65+i)}",
            "distance": "",
            "eta":      "",
            "coords":   [],
            "segments": analysis["segments"],
            "metadata": analysis["metadata"],
        })

    return results