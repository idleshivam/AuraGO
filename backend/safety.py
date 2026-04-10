def calculate_segment_score(seg, women_mode=False):
    """
    Score a single road segment.

    Normal mode  : 0.5*activity + 0.3*crowd + 0.2*lighting
    Women mode   : 0.4*activity + 0.4*crowd + 0.2*lighting
                   + heavy penalty when crowd < 20 (isolated area)
    """
    if women_mode:
        score = (
            0.40 * seg["activity"] +
            0.40 * seg["crowd"] +
            0.20 * seg["lighting"]
        )
        # Strong penalty for very low crowd (unsafe isolated stretch)
        if seg["crowd"] < 20:
            score -= 15
    else:
        score = (
            0.50 * seg["activity"] +
            0.30 * seg["crowd"] +
            0.20 * seg["lighting"]
        )

    return score


def calculate_route_safety(segments, women_mode=False):
    """Average segment score across the whole route.

    Women mode veto: if ANY segment is critically isolated + dark
    (crowd<15 AND lighting<30), the entire route is capped at 30
    so it always ranks last — making routing visibly change.
    """
    scores = [calculate_segment_score(s, women_mode=women_mode) for s in segments]
    avg = round(sum(scores) / len(scores), 2)

    if women_mode:
        # Hard veto: at least one critically unsafe segment → force route to bottom
        critically_unsafe = any(
            s["crowd"] < 15 and s["lighting"] < 30 for s in segments
        )
        if critically_unsafe:
            avg = min(avg, 30)  # cap score → always ranked last

    return avg


def label_segment(seg, women_mode=False):
    """
    Return a safety label for a single segment so the frontend
    can color-code each portion of the route line.

    Returns one of: 'safe' | 'moderate' | 'danger'
    """
    score = calculate_segment_score(seg, women_mode=women_mode)
    if score >= 65:
        return "safe"
    if score >= 45:
        return "moderate"
    return "danger"


def detect_risks(segments, women_mode=False):
    """
    Detect risk conditions along a route.

    Women mode adds stricter checks:
      • crowd < 25  → unsafe for women (low crowd)
      • activity < 30 → low activity area
      • isolated + dark → high-risk combo
    """
    risks = []

    for i, seg in enumerate(segments):
        label = f"segment {i + 1}"

        if women_mode:
            # ── Women-mode stricter checks ──────────────────────────
            if seg["crowd"] < 25:
                risks.append(
                    f"⚠️ Unsafe for women at {label} (low crowd — isolated stretch)"
                )
            elif seg["activity"] < 30:
                risks.append(
                    f"⚠️ Low activity area at {label} (sparse foot traffic)"
                )
            elif seg["crowd"] < 30 and seg["lighting"] < 40:
                risks.append(
                    f"🚨 High risk at {label} (isolated & poorly lit — avoid at night)"
                )
            elif seg["crowd"] > 88:
                risks.append(f"Overcrowded area at {label}")
        else:
            # ── Normal mode (original logic) ────────────────────────
            if seg["activity"] < 25:
                risks.append(
                    f"Deserted area at {label} (very low foot traffic)"
                )
            elif seg["crowd"] < 20 and seg["lighting"] < 40:
                risks.append(
                    f"High risk at {label} (isolated & poorly lit)"
                )
            elif seg["crowd"] < 15 and seg["activity"] < 30:
                risks.append(
                    f"Isolated zone at {label} (minimal crowd & activity)"
                )
            elif seg["activity"] < 40 and seg["crowd"] < 30:
                risks.append(
                    f"Low activity at {label} (sparse traffic area)"
                )
            elif seg["crowd"] > 88:
                risks.append(f"Overcrowded area at {label}")

    return risks


def get_safety_explanation(route, women_mode=False):
    """
    Return a human-readable feel + explanation dict for the given route.

    Parameters
    ----------
    route       : dict with 'safety_score' and 'name' keys
    women_mode  : bool

    Returns
    -------
    dict: { "feels_like": str, "explanation": str }
    """
    score = route.get("safety_score", 50)

    if women_mode:
        if score >= 70:
            feels_like = "Safe"
            explanation = (
                "This route is recommended in Women Safety Mode. "
                "It avoids isolated roads and prefers well-crowded, well-lit streets. "
                "Higher crowd density acts as a deterrent and improves overall safety."
            )
        elif score >= 50:
            feels_like = "Moderate Risk"
            explanation = (
                "Some segments on this route have lower-than-ideal crowd levels. "
                "Women Safety Mode has flagged areas where foot traffic is sparse. "
                "Consider sharing your live location before taking this route."
            )
        else:
            feels_like = "High Risk"
            explanation = (
                "This route is NOT recommended in Women Safety Mode. "
                "It passes through isolated stretches with low crowd and poor lighting. "
                "Please choose a route with higher crowd density and better lighting."
            )
    else:
        if score >= 70:
            feels_like = "Safe"
            explanation = "This route has good activity levels and sufficient lighting."
        elif score >= 50:
            feels_like = "Moderate"
            explanation = "This route has average safety. Stay alert in low-traffic segments."
        else:
            feels_like = "Unsafe"
            explanation = "This route has low activity and poor lighting in several segments."

    return {"feels_like": feels_like, "explanation": explanation}