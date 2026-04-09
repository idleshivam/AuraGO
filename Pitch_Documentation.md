# SafeRoute AI - Technical Pitch & Architecture Documentation

This document is designed to help you present the technical depths of SafeRoute AI to judges, breaking down the difference between the hackathon prototype and the intended real-world architecture.

---

## 1. How are we collecting Safety Data?

### In our Current Code (The Hackathon Prototype):
We have built a proprietary logic engine (located in `backend/safety.py`) that acts as the core "Safety Engine". Because we do not have access to a massive live database of municipal crime metrics for the prototype, the backend (`backend/data.py`) **procedurally generates intelligent test data** for each route. 

It splits the route into internal "segments" and generates mock variable arrays representing:
1. **Crowd Levels**
2. **Lighting / Lux levels**
3. **General Regional Activity**

### In the Real-World Pitch (What you tell the Judges):
If this application was fully funded and launched, it would aggregate real-world big data from four layers:
1. **Government APIs:** Integrating Police Crime databases (FIR locations, past harassment reports) mapped tightly to geographic polygons.
2. **Crowdsourcing (Waze Model):** Allowing users to anonymously "pin" zones that are unlit, have loitering groups, or feel inherently unsafe in real-time.
3. **OpenStreetMap Tags:** Scanning OSM metadata for specific infrastructure tags like `lit=no` (no streetlights) or `cctv=yes` programmatically.
4. **Live Feed Analysis:** Using municipal CCTV feeds or satellite density data to track live foot traffic.

---

## 2. How do we *know* a Route is Safe? 

Once we have the data arrays, we pass it into the **Algorithmic Analytics Engine** (`backend/safety.py`).

### The Mathematics of Safety:
The Python backend splits every single journey on the map into smaller "Segments". It then applies a mathematical **Weighted Average** formula to evaluate the risk:

```python
# The actual Python formula evaluating segments
Score = (0.4 * Crowd_Level) + (0.3 * Street_Lighting) + (0.3 * Regional_Activity)
```

- **High Risk Detection:** The Python logic strictly scans these arrays. If a road segment registers as `< 40% Lighting` AND `< 20% Crowd`, the system explicitly flags it as a highly dangerous **"Isolated & Dark"** zone. 
- **Score Generation:** It averages out all segment scores to forge a final **0-100 Safety Score** for the overall route. 
- **The UI Reaction:** When you activate the **"Women Safety Mode"**, the app bypasses standard GPS shortest-path algorithms. It forces the map to render and highlight the route with the highest Safety Score—prioritizing a well-lit, longer route over a fast, dangerous, isolated shortcut.

---

## 3. What Technology Stack are we using?

We avoided slow/bulky enterprise frameworks to ensure the app is lightning fast on mobile devices.

### A. THE MAP LAYER (VISUALS)
*   **Leaflet.js:** An elite open-source geographic mapping system built in JavaScript. It dynamically renders the UI map, manages your live GPS footprint tracking, and draws the glowing, multi-colored SVG route lines.
*   **OpenStreetMap (OSM):** Provides the vast dataset and background basemap tiles (rendering the physical roads, parks, and buildings) for free.

### B. THE SEARCH & ROUTING ENGINE (THE BRAINS)
*   **Photon API (by Komoot):** This powers the incredibly fast Autocomplete search bar. Photon uses *Elasticsearch* to handle fuzzy typos natively (e.g., predicting "Karnavati University" if you just type "Karna"). We inject a mathematical **100km Geolocation Bounding Box** in the frontend to force it to prioritize local Indian venues instead of displaying McDonald's locations in the USA.
*   **Project-OSRM Engine:** Once you pick a destination, we request the *Open Source Routing Machine*. It calculates the absolute geometric driving path connecting you to your destination. Since default OSRM calculates ETAs based on empty European roads, we programmed a custom **`1.35x` traffic multiplier** into the JavaScript to ensure ETAs match realistic Indian traffic!

### C. THE BACKEND (THE SERVER)
*   **Python 3:** Handles the heavy lifting and data algorithms.
*   **Flask Framework:** Serves as the networking API. It hosts the entire application on the local Wi-Fi port `0.0.0.0`, allowing you to seamlessly present the app on your personal mobile phone connected to the same Wi-Fi, without needing to pay for AWS cloud deployment.
*   **Vanilla HTML/CSS/JS:** The frontend strictly relies on Vanilla scripting. We used pure CSS logic for everything from the animated SVG 100-point circle in the Safety Card, to the pulsating **Emergency SOS Button** that natively launches the `tel:100` system dialer when triggered.

---
*Created for the 36-Hour Hackathon Presentation.*
