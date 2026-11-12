# Atlas — The world, in the news

## Start the app

Double-click **Start Atlas.cmd** in this folder. It starts the Python service and opens **http://127.0.0.1:8765** in your browser. Keep its command window open while using Atlas. Press Ctrl+C in that window to stop it.

Alternatively, run `py -3 server.py --open` from this folder. Python 3.10 or later is required. No packages or API keys are needed.

Once the service is running, you can also open `index.html` directly or use a local static preview server. The frontend connects those pages to the service on port 8765. If the service is stopped, the drawer explains how to start it. `Start Atlas.cmd` is still the easiest way to launch both the service and page together.

## Country news

The local service requests Bing News and Google News RSS in parallel for the selected country. It merges up to 20 unique recent stories, retaining feed order with Bing results first. Both sources are searched; either can supply results if the other is unavailable. Headlines are preserved, publishers are attributed, and feed thumbnails are used when provided. Google links open through Google News. Missing thumbnails show an image-unavailable placeholder. Dates are publication dates reported by the feeds.

The server waits at most seven seconds for feeds. The frontend enforces a ten-second request deadline, with an additional twelve-second drawer watchdog. Closing the drawer or switching countries cancels the browser request and prevents old results from replacing the selection. Results are cached separately for each country for five minutes; failed and empty searches are not cached.

Country aliases support abbreviated map names. Coverage and result counts vary by country. No sample headlines are generated. RSS feeds are used here as a personal news reader; their providers' feed terms apply.

The app listens only on `127.0.0.1`. An internet connection is needed for news, map geometry, fonts, and images. The map uses D3, TopoJSON, and world-atlas from public CDNs.

## Live daylight and local time

The map shows an approximate day/night boundary computed from the current UTC date and time using the [NOAA solar equations](https://gml.noaa.gov/grad/solcalc/solareqns.PDF). The night shading has alpha 0.3 and updates every minute. A small sun marks the subsolar point. Country hover and selection show a location pin at opacity 0.3, a clock that updates every second, and Daylight, Twilight, or Night at the reference city. Twilight covers the period when the Sun is between approximately 0.833 and 6 degrees below the horizon; this is a solar estimate, not weather data.

Clocks use named IANA time zones through the browser's `Intl.DateTimeFormat`, including the browser's current daylight saving rules. Each country shows a named reference city, usually its capital, because a country can span several time zones. Antarctica is explicitly labelled as a UTC reference. Both the daylight overlay and location pin follow map zoom and resize. These features need no additional live API and work when opening the page as a local file.

`country-times.js` bundles reference coordinates and IANA zone names. Its source identifiers and country metadata derive from [mledoze/countries](https://github.com/mledoze/countries), under the [Open Database License](COUNTRY-DATA-LICENSE.txt); reference coordinates derive from [Stefie/geojson-world](https://github.com/Stefie/geojson-world), with selected reference-city corrections in the build script. Time zone selection uses the public-domain [IANA zone.tab](https://github.com/eggert/tz/blob/main/zone.tab). The script chooses the nearest time zone reference point for each city's country, with explicit overrides where needed. Run `py -3 scripts/build-country-times.py` to rebuild this bundled dataset. The browser's time zone database determines current offsets.