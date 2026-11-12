"""Rebuild the bundled reference-city/IANA dataset; requires internet, no packages."""
import json
import math
from pathlib import Path
import re
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]


def read(url):
    with urlopen(url, timeout=15) as response:
        return response.read().decode("utf-8")


def coordinate(value):
    sign = -1 if value[0] == "-" else 1
    part = value[1:]
    digits = 2 if len(part) in (4, 6) else 3
    return sign * (int(part[:digits]) + int(part[digits:digits+2]) / 60
                   + (int(part[digits+2:]) / 3600 if len(part) > digits+2 else 0))


def distance(a, b):
    lon1, lat1 = map(math.radians, a)
    lon2, lat2 = map(math.radians, b)
    return math.sin((lat1-lat2)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin((lon1-lon2)/2)**2


countries = json.loads(read("https://raw.githubusercontent.com/mledoze/countries/master/countries.json"))
capitals = json.loads(read("https://raw.githubusercontent.com/Stefie/geojson-world/master/capitals.geojson"))["features"]
capitals = {f["properties"]["iso2"]: f for f in capitals if f["properties"].get("city")}
zones = {}
for line in read("https://raw.githubusercontent.com/eggert/tz/main/zone.tab").splitlines():
    if not line or line.startswith("#"):
        continue
    code, coords, zone, *_ = line.split("\t")
    lat, lon = re.findall(r"[+-]\d+", coords)
    zones.setdefault(code, []).append((zone, [coordinate(lon), coordinate(lat)]))

overrides = {
    "IN": ("New Delhi", [77.209, 28.614], "Asia/Kolkata"),
    "US": ("Washington, D.C.", [-77.037, 38.907], "America/New_York"),
    "BR": ("Brasília", [-47.883, -15.794], "America/Sao_Paulo"),
    "AU": ("Canberra", [149.13, -35.28], "Australia/Sydney"),
    "BI": ("Gitega", [29.925, -3.427], "Africa/Bujumbura"),
    "KZ": ("Astana", [71.43, 51.17], "Asia/Almaty"),
    "MM": ("Naypyidaw", [96.129, 19.763], "Asia/Yangon"),
    "PW": ("Ngerulmud", [134.624, 7.501], "Pacific/Palau"),
    "LK": ("Sri Jayawardenepura Kotte", [79.916, 6.895], "Asia/Colombo"),
    "AQ": ("UTC reference", [0, -80], "UTC"),
}
records = {}
for country in countries:
    iso, code = country["cca2"], country.get("ccn3")
    capital, choices = capitals.get(iso), zones.get(iso, [])
    if iso in overrides:
        city, point, zone = overrides[iso]
    elif capital and choices:
        city, point = capital["properties"]["city"], capital["geometry"]["coordinates"]
        zone = min(choices, key=lambda item: distance(point, item[1]))[0]
    elif choices:
        zone, point = choices[0]
        city = zone.rsplit("/", 1)[-1].replace("_", " ")
    else:
        continue
    if code:
        records[code.zfill(3)] = {"city": city, "coordinates": point, "zone": zone,
                               "zones": [z[0] for z in choices] or [zone]}

specials = {
    "Kosovo": {"city": "Pristina", "coordinates": [21.166, 42.663], "zone": "Europe/Belgrade", "zones": ["Europe/Belgrade"]},
    "Somaliland": {"city": "Hargeisa", "coordinates": [44.064, 9.562], "zone": "Africa/Mogadishu", "zones": ["Africa/Mogadishu"]},
    "N. Cyprus": {"city": "North Nicosia", "coordinates": [33.361, 35.185], "zone": "Asia/Famagusta", "zones": ["Asia/Famagusta"]},
}
records["383"] = specials["Kosovo"]
data = {"byId": records, "byName": specials}
(ROOT / "country-times.js").write_text(
    "// Bundled city coordinates and IANA zones. Sources and licence: README.md.\nwindow.ATLAS_COUNTRY_TIMES = "
    + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
(ROOT / "COUNTRY-DATA-LICENSE.txt").write_text(
    read("https://raw.githubusercontent.com/mledoze/countries/master/LICENSE"), encoding="utf-8")
print(f"Bundled {len(records)} country references and {len(specials)} map exceptions.")
