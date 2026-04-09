def calculate_segment_score(seg):
    # Activity is the MOST important factor (50%) — a busy road is safer
    # Crowd presence (30%) — more people = more witnesses/deterrent
    # Lighting (20%) — still matters but secondary to human presence
    return (
        0.50 * seg["activity"] +
        0.30 * seg["crowd"] +
        0.20 * seg["lighting"]
    )

def calculate_route_safety(segments):
    scores = [calculate_segment_score(s) for s in segments]
    return round(sum(scores) / len(scores), 2)


def detect_risks(segments):
    risks = []

    for i, seg in enumerate(segments):
        # PRIMARY: Very low activity = deserted zone (most dangerous)
        if seg["activity"] < 25:
            risks.append(f"Deserted area at segment {i+1} (very low foot traffic)")
        # HIGH RISK: isolated + dark combo
        elif seg["crowd"] < 20 and seg["lighting"] < 40:
            risks.append(f"High risk at segment {i+1} (isolated & poorly lit)")
        # Dead zone at night
        elif seg["crowd"] < 15 and seg["activity"] < 30:
            risks.append(f"Isolated zone at segment {i+1} (minimal crowd & activity)")
        # Low-traffic street even with some lighting
        elif seg["activity"] < 40 and seg["crowd"] < 30:
            risks.append(f"Low activity at segment {i+1} (sparse traffic area)")
        # Overcrowded (different kind of risk)
        elif seg["crowd"] > 88:
            risks.append(f"Overcrowded area at segment {i+1}")

    return risks