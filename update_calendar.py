# /// script
# requires-python = ">=3.13"
# dependencies = [
#     "requests",
#     "tqdm",
# ]
# ///
import requests
import json
from tqdm import tqdm

base_url = "https://site.api.espn.com/apis/site/v2/sports/football/college-football/scoreboard"


def get_calendar(year: int):
    j = requests.get(f"{base_url}?dates={year}0901")
    calendar = j.json()['leagues'][0]['calendar']

    weeks = []
    for t in calendar:
        if t["value"] == "4":
            continue

        for e in t['entries']:
            e['year'] = f"{year}"
            e["type"] = t["value"]
            weeks.append(e)

    return weeks

# Bump the upper bound to a future year to extend the week switcher.
# Output is read at Worker build time via a TypeScript JSON import in
# worker/src/lib/schedule.ts.
result = {}
for yr in tqdm(range(2002, 2026)):
    result[yr] = get_calendar(yr)

with open("./worker/src/data/schedule.json", "w") as f:
    f.write(json.dumps(result))
