def calculate_segment_score(seg):
    return (
        0.4 * seg["crowd"] +
        0.3 * seg["lighting"] +
        0.3 * seg["activity"]
    )

def calculate_route_safety(segments):
    scores = [calculate_segment_score(s) for s in segments]
    return round(sum(scores) / len(scores), 2)


def detect_risks(segments):
    risks = []

    for i, seg in enumerate(segments):
        # High risk: empty + dark
        if seg["crowd"] < 20 and seg["lighting"] < 40:
            risks.append(f"High risk at segment {i+1} (isolated & dark)")

        # Overcrowded risk
        elif seg["crowd"] > 85:
            risks.append(f"Overcrowded at segment {i+1}")

        # Low activity
        elif seg["activity"] < 20:
            risks.append(f"Low activity at segment {i+1}")

    return risks