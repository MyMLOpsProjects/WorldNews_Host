/* Approximate solar position: NOAA solar equations. Civil time: browser IANA data. */
window.AtlasDaylight = (() => {
  const RAD = Math.PI / 180;
  const formatters = new Map();
  let config, overlay, dayPath, nightPath, horizonPath, sunMarker, pin, clip;
  let hovered = null, selected = null, lastSolarMinute = -1, sun;
  let timer;

  function solarPosition(date = new Date()) {
    const year = date.getUTCFullYear();
    const start = Date.UTC(year, 0, 1);
    const daysInYear = (Date.UTC(year + 1, 0, 1) - start) / 86400000;
    const gamma = 2 * Math.PI / daysInYear * ((date.getTime() - start) / 86400000 - 0.5);
    const eqTime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma)
      - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
    const declination = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma)
      - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma)
      - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
    const minutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    const longitude = ((180 - (minutes + eqTime) / 4 + 180) % 360 + 360) % 360 - 180;
    return [longitude, declination / RAD];
  }

  function solarAltitude(point, position) {
    const [lon, lat] = point.map(value => value * RAD);
    const [sunLon, sunLat] = position.map(value => value * RAD);
    const dot = Math.sin(lat) * Math.sin(sunLat) + Math.cos(lat) * Math.cos(sunLat) * Math.cos(lon - sunLon);
    return Math.asin(Math.max(-1, Math.min(1, dot))) / RAD;
  }

  function daylightAt(point, date = new Date()) {
    const altitude = solarAltitude(point, solarPosition(date));
    return altitude >= -0.833 ? 'Daylight' : altitude >= -6 ? 'Twilight' : 'Night';
  }

  function referenceFor(feature) {
    if (!feature) return null;
    const data = window.ATLAS_COUNTRY_TIMES;
    const name = config.nameOf(feature);
    const record = data.byName[feature.properties.name] || data.byName[name]
      || data.byId[String(feature.id).padStart(3, '0')];
    return record ? { ...record, country: name } : null;
  }

  function formatter(zone) {
    if (!formatters.has(zone)) {
      formatters.set(zone, {
        time: new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }),
        date: new Intl.DateTimeFormat('en-GB', { timeZone: zone, weekday: 'short', day: 'numeric', month: 'short' }),
        offset: new Intl.DateTimeFormat('en', { timeZone: zone, timeZoneName: 'longOffset' }),
      });
    }
    return formatters.get(zone);
  }

  function offsetAt(zone, date) {
    return formatter(zone).offset.formatToParts(date).find(part => part.type === 'timeZoneName').value.replace('GMT', 'UTC');
  }

  function paintClock(container, record, now) {
    if (!container) return;
    container.hidden = !record;
    if (!record) return;
    const formats = formatter(record.zone);
    const status = daylightAt(record.coordinates, now);
    const fields = {
      country: record.country,
      time: formats.time.format(now),
      place: record.city,
      date: `${formats.date.format(now)} · ${offsetAt(record.zone, now)}`,
      status,
      note: record.city === 'UTC reference' ? 'NO SINGLE LOCAL TIME · UTC SHOWN' : 'REFERENCE CITY TIME',
    };
    for (const [key, text] of Object.entries(fields)) {
      const element = container.querySelector(`[data-clock-${key}]`);
      if (element) element.textContent = text;
    }
    container.dataset.daylight = status.toLowerCase();
    container.title = `${record.city} · ${record.zone}. Large countries can span several time zones. Daylight is estimated at this location.`;
  }

  function drawSolar(date) {
    if (!config) return;
    const projection = config.projection();
    if (!projection) return;
    sun = solarPosition(date);
    const geoPath = d3.geoPath(projection);
    clip.attr('d', geoPath({ type: 'Sphere' }));
    dayPath.attr('d', geoPath(d3.geoCircle().center(sun).radius(90).precision(1)()));
    const antipode = [sun[0] > 0 ? sun[0] - 180 : sun[0] + 180, -sun[1]];
    nightPath.attr('d', geoPath(d3.geoCircle().center(antipode).radius(90).precision(1)()));
    horizonPath.attr('d', geoPath(d3.geoCircle().center(antipode).radius(90).precision(1)()));
    const point = projection(sun);
    sunMarker.attr('transform', `translate(${point[0]},${point[1]})`);
    lastSolarMinute = Math.floor(date.getTime() / 60000);
  }

  function drawPin(record) {
    if (!pin) return;
    pin.style('display', record ? null : 'none');
    if (!record) return;
    const point = config.projection()(record.coordinates);
    pin.attr('transform', `translate(${point[0]},${point[1]})`);
  }

  function tick() {
    if (!config) return;
    const now = new Date();
    if (Math.floor(now.getTime() / 60000) !== lastSolarMinute) drawSolar(now);
    const utc = document.querySelector('#worldUTC');
    if (utc) utc.textContent = `${now.toISOString().slice(11, 19)} UTC`;
    const record = referenceFor(hovered || selected);
    paintClock(document.querySelector('#countryClock'), record, now);
    paintClock(document.querySelector('#drawerLocalTime'), referenceFor(selected), now);
    const tooltipTime = document.querySelector('#tooltipLocalTime');
    if (tooltipTime) tooltipTime.textContent = hovered && record
      ? `${formatter(record.zone).time.format(now)} · ${daylightAt(record.coordinates, now)} · ${record.city}` : '';
    drawPin(record);
  }

  function init(options) {
    config = options;
    clip = config.svg.append('defs').append('clipPath').attr('id', 'solar-world-clip').append('path');
    overlay = config.viewport.append('g').attr('class', 'solar-overlay').attr('clip-path', 'url(#solar-world-clip)').attr('pointer-events', 'none').attr('aria-hidden', 'true');
    dayPath = overlay.append('path').attr('class', 'solar-day');
    nightPath = overlay.append('path').attr('class', 'solar-night');
    horizonPath = overlay.append('path').attr('class', 'solar-horizon');
    sunMarker = overlay.append('g').attr('class', 'subsolar-point');
    sunMarker.append('circle').attr('r', 11).attr('class', 'sun-halo');
    sunMarker.append('circle').attr('r', 3).attr('class', 'sun-core');
    pin = config.viewport.append('g').attr('class', 'country-time-pin').attr('pointer-events', 'none').attr('aria-hidden', 'true');
    pin.append('path').attr('d', 'M0 0C-3-6-11-13-11-21a11 11 0 0 1 22 0C11-13 3-6 0 0Z');
    pin.append('circle').attr('cx', 0).attr('cy', -21).attr('r', 3.5);
    drawSolar(new Date());
    tick();
    clearInterval(timer);
    timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', tick);
  }

  return {
    init, solarPosition, solarAltitude, daylightAt,
    resize() { drawSolar(new Date()); tick(); },
    hover(feature) { hovered = feature; tick(); },
    select(feature) { selected = feature; tick(); },
  };
})();
