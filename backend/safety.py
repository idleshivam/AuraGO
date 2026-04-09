def calculate_safety(crowd, lighting, activity):
    score = (
        0.4 * crowd +
        0.3 * lighting +
        0.3 * activity
    )
    return round(score, 2)