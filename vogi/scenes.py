"""Role-play scenes for Talk. Everyday situations an adult learner in Germany meets early.

Written for Vogi during the hackathon. The names are made up.
"""

SCENES = {
    "bakery": {
        "title": "At the bakery",
        "partner": "Frau Krause, the baker at a small bakery in Leipzig. Friendly and quick.",
        "setting": "Morning at the bakery counter. The learner is a customer.",
        "goals": [
            "Greet the baker",
            "Order two bread rolls and one more thing",
            "Ask how much it costs",
            "Pay and say goodbye",
        ],
    },
    "sick": {
        "title": "Call in sick",
        "partner": "Frau Becker, the learner's team manager. Calm and polite, on the phone.",
        "setting": "Early morning phone call. The learner is ill and cannot come to work.",
        "goals": [
            "Say who you are",
            "Say that you are ill and cannot come today",
            "Say when you will see a doctor or come back",
            "End the call politely",
        ],
    },
    "parcel": {
        "title": "The neighbour has your parcel",
        "partner": "Herr Yilmaz, a helpful neighbour who took in a parcel for the learner.",
        "setting": "At the neighbour's door in the evening. The learner moved in last week.",
        "goals": [
            "Greet him and say you are the new neighbour",
            "Ask about your parcel",
            "Thank him",
        ],
    },
    "doctor": {
        "title": "Book a doctor's appointment",
        "partner": "Herr Schulz at the reception of a family doctor's practice, on the phone.",
        "setting": "The learner calls the practice to get an appointment.",
        "goals": [
            "Ask for an appointment",
            "Say what the problem is",
            "Agree on a day and a time",
        ],
    },
    "office": {
        "title": "Register your address",
        "partner": "Frau Lange, a clerk at the Bürgeramt (citizens' office). Correct and patient.",
        "setting": "At the desk of the Bürgeramt. The learner wants to register a new flat (Anmeldung).",
        "goals": [
            "Say why you are here",
            "Say when you moved in",
            "Ask which documents you need",
        ],
    },
}


def public() -> list[dict]:
    return [{"id": k, "title": v["title"], "goals": v["goals"]} for k, v in SCENES.items()]
