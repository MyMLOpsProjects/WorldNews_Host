const svg=d3.select('#worldMap'),frame=document.querySelector('.map-frame'),tooltip=document.querySelector('#mapTooltip');let projection,path,worldFeatures=[],featureByName=new Map(),selectedFeature=null,hoverFeature=null,zoomBehavior;
const countryAliases={'United States of America':'United States','Russian Federation':'Russia','Korea, Republic of':'South Korea','Korea, Democratic People\'s Republic of':'North Korea','Iran (Islamic Republic of)':'Iran','Viet Nam':'Vietnam','Syrian Arab Republic':'Syria','Lao People\'s Democratic Republic':'Laos','Czechia':'Czech Republic','Democratic Republic of the Congo':'Democratic Republic of the Congo','Republic of the Congo':'Republic of the Congo','Türkiye':'Turkey','United Republic of Tanzania':'Tanzania','Côte d’Ivoire':'Ivory Coast','Côte d\'Ivoire':'Ivory Coast','The Gambia':'Gambia','Eswatini':'Eswatini','North Macedonia':'North Macedonia','Moldova':'Moldova','Brunei Darussalam':'Brunei','Timor-Leste':'East Timor','Bahamas':'Bahamas','Bolivia':'Bolivia','Venezuela':'Venezuela','Taiwan':'Taiwan','Palestine':'Palestine'};
function canonical(n){return countryAliases[n]||n}function featureName(f){return canonical(f.properties.name||'Unknown')}let mapViewport;
function resizeMap() {
  const width = frame.clientWidth, height = frame.clientHeight;
  svg.attr('viewBox', `0 0 ${width} ${height}`);
  if (!worldFeatures.length) return;
  projection = d3.geoNaturalEarth1().fitExtent([[12,16],[width-12,height-26]], {type:'FeatureCollection',features:worldFeatures});
  path = d3.geoPath(projection);
  mapViewport.selectAll('.country').attr('d', path);
  mapViewport.select('.world-ocean').attr('d', path({type:'Sphere'}));
  AtlasDaylight.resize();
}
async function initMap() {
  try {
    const data = await d3.json('https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json');
    worldFeatures = topojson.feature(data, data.objects.countries).features;
    worldFeatures.forEach(feature => featureByName.set(featureName(feature), feature));
    mapViewport = svg.append('g').attr('class', 'map-viewport');
    mapViewport.append('path').attr('class', 'world-ocean').attr('pointer-events', 'none');
    mapViewport.selectAll('.country').data(worldFeatures).join('path').attr('class', 'country')
      .on('mouseenter', (event, feature) => {
        hoverFeature = feature;
        event.currentTarget.classList.add('hovered');
        tooltip.querySelector('strong').textContent = featureName(feature);
        AtlasDaylight.hover(feature);
        tooltip.classList.add('visible');
        positionTooltip(event);
      })
      .on('mousemove', positionTooltip)
      .on('mouseleave', event => {
        event.currentTarget.classList.remove('hovered');
        hoverFeature = null;
        AtlasDaylight.hover(null);
        tooltip.classList.remove('visible');
      })
      .on('click', (event, feature) => { event.stopPropagation(); openCountry(featureName(feature)); });
    resizeMap();
    AtlasDaylight.init({svg, viewport:mapViewport, projection:()=>projection, nameOf:featureName});
    zoomBehavior = d3.zoom().scaleExtent([1,5]).on('zoom', event => mapViewport.attr('transform', event.transform));
    svg.call(zoomBehavior).on('dblclick.zoom', null);
  } catch (error) {
    document.querySelector('.map-caption').textContent = 'MAP UNAVAILABLE · CHECK YOUR CONNECTION';
    console.error('Could not load map data', error);
  }
}
function positionTooltip(e){const r=frame.getBoundingClientRect(),t=tooltip.getBoundingClientRect();let x=e.clientX-r.left+12,y=e.clientY-r.top+12;if(x+t.width>r.width-8)x-=t.width+26;if(y+t.height>r.height-8)y-=t.height+26;tooltip.style.left=`${Math.max(4,x)}px`;tooltip.style.top=`${Math.max(4,y)}px`}
let newsController = null;
let newsRequestId = 0;
const newsList = document.querySelector('#newsList');
const drawerFoot = document.querySelector('.drawer-foot');
newsList.setAttribute('aria-live', 'polite');

function newsStatus(title, message, retryCountry) {
  const box = document.createElement('div');
  box.className = 'news-status';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const copy = document.createElement('p');
  copy.textContent = message;
  box.append(heading, copy);
  if (retryCountry) {
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Try again';
    retry.addEventListener('click', () => openCountry(retryCountry));
    box.append(retry);
  }
  newsList.replaceChildren(box);
}

function renderStories(stories) {
  const cards = stories.map((story, index) => {
    const card = document.createElement('article');
    card.className = 'news-card';
    const body = document.createElement('div');
    const kicker = document.createElement('div');
    kicker.className = 'news-kicker';
    kicker.textContent = `HEADLINE · ${String(index + 1).padStart(2, '0')}`;
    const heading = document.createElement('h3');
    const link = document.createElement('a');
    link.href = story.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = story.title;
    heading.append(link);
    const meta = document.createElement('div');
    meta.className = 'news-meta';
    meta.textContent = story.source;
    if (story.publishedAt) {
      const time = document.createElement('time');
      time.dateTime = story.publishedAt;
      time.textContent = ` · ${new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(story.publishedAt))}`;
      time.title = `Published: ${new Date(story.publishedAt).toLocaleString()}`;
      meta.append(time);
    }
    body.append(kicker, heading, meta);
    const media = document.createElement('div');
    media.className = 'news-media';
    const placeholder = document.createElement('span');
    placeholder.className = 'news-image-placeholder';
    placeholder.textContent = 'IMAGE UNAVAILABLE';
    media.append(placeholder);
    if (story.image) {
      const image = document.createElement('img');
      image.className = 'news-thumb';
      image.loading = 'lazy';
      image.alt = '';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove(), { once: true });
      image.src = story.image;
      media.append(image);
    }
    card.append(body, media);
    return card;
  });
  newsList.replaceChildren(...cards);
}

async function openCountry(name) {
  if (!name || name === 'Unknown') return;
  const feature = featureByName.get(name);
  if (!feature) { toast(`News for ${name} is coming soon`); return; }
  newsController?.abort();
  newsController = new AbortController();
  const controller = newsController;
  const requestId = ++newsRequestId;
  selectedFeature = feature;
  AtlasDaylight.select(feature);
  svg.selectAll('.country').classed('selected', d => d === feature);
  tooltip.classList.remove('visible');
  document.querySelector('#drawerCountry').textContent = name;
  document.querySelector('#updatedAt').textContent = 'LOADING';
  document.querySelector('#storyCount').textContent = 'FINDING STORIES';
  drawerFoot.textContent = 'SEARCHING COVERAGE FROM THE PAST 7 DAYS';
  newsStatus('Finding the latest stories…', `Searching news coverage about ${name}.`);
  newsList.setAttribute('aria-busy', 'true');
  newsList.scrollTop = 0;
  const drawer = document.querySelector('#newsDrawer');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  document.querySelector('#drawerBackdrop').classList.add('open');
  document.body.style.overflow = 'hidden';
  let watchdog;
  try {
    const result = await Promise.race([
      AtlasNews.getStories(name, { signal: controller.signal }),
      new Promise((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('The news search took too long. Please try again.')), 12000);
      }),
    ]);
    if (requestId !== newsRequestId || controller.signal.aborted) return;
    document.querySelector('#updatedAt').textContent = new Intl.DateTimeFormat('en', { hour: '2-digit', minute: '2-digit' }).format(new Date(result.fetchedAt));
    document.querySelector('#storyCount').textContent = `${result.articles.length} ${result.articles.length === 1 ? 'STORY' : 'STORIES'}`;
    if (result.articles.length) {
      renderStories(result.articles);
      drawerFoot.textContent = `PAST 7 DAYS · VIA ${result.provider.toUpperCase()}`;
    } else {
      newsStatus('No recent stories found', `No matching English-language coverage for ${name} was returned for the past 7 days.`, name);
      drawerFoot.textContent = 'NEWS COVERAGE VARIES BY COUNTRY';
    }
  } catch (error) {
    if (requestId !== newsRequestId || controller.signal.aborted) return;
    document.querySelector('#updatedAt').textContent = 'UNAVAILABLE';
    document.querySelector('#storyCount').textContent = 'NEWS UNAVAILABLE';
    drawerFoot.textContent = 'LIVE NEWS IS TEMPORARILY UNAVAILABLE';
    newsStatus('Could not load the news', error.message || 'Please try again in a moment.', name);
  } finally {
    clearTimeout(watchdog);
    controller.abort();
    if (requestId === newsRequestId) newsList.setAttribute('aria-busy', 'false');
  }
}

function closeDrawer() {
  newsController?.abort();
  newsRequestId++;
  newsList.setAttribute('aria-busy', 'false');
  document.querySelector('#newsDrawer').classList.remove('open');
  document.querySelector('#newsDrawer').setAttribute('aria-hidden', 'true');
  document.querySelector('#drawerBackdrop').classList.remove('open');
  document.body.style.overflow = '';
  svg.selectAll('.country').classed('selected', false);
  selectedFeature = null;
  AtlasDaylight.select(null);
}
let toastTimer;function toast(m){const t=document.querySelector('#toast');t.textContent=m;t.classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove('show'),2200)}
function searchCountries(value){const box=document.querySelector('#searchResults'),q=value.trim().toLowerCase();if(!q){box.classList.remove('open');box.innerHTML='';return}const matches=[...featureByName.keys()].filter(n=>n.toLowerCase().includes(q)).slice(0,7);box.innerHTML=matches.length?matches.map(n=>`<div class="search-result" data-name="${n.replaceAll('"','&quot;')}">${n}</div>`).join(''):'<div class="search-result">No countries found</div>';box.classList.add('open')}
document.querySelector('#countrySearch').addEventListener('input',e=>searchCountries(e.target.value));document.querySelector('#searchResults').addEventListener('click',e=>{const n=e.target.dataset.name;if(n){openCountry(n);document.querySelector('#countrySearch').value='';searchCountries('')}});document.addEventListener('click',e=>{if(!e.target.closest('.search-box'))document.querySelector('#searchResults').classList.remove('open')});document.querySelector('#resetMap').addEventListener('click',()=>{if(zoomBehavior)svg.transition().duration(500).call(zoomBehavior.transform,d3.zoomIdentity);closeDrawer()});document.querySelector('#closeDrawer').addEventListener('click',closeDrawer);document.querySelector('#drawerBackdrop').addEventListener('click',closeDrawer);document.querySelectorAll('.region-chips button').forEach(b=>b.addEventListener('click',()=>openCountry(b.dataset.country)));document.querySelector('#today').textContent=new Intl.DateTimeFormat('en',{weekday:'short',month:'short',day:'numeric'}).format(new Date()).toUpperCase();document.querySelector('#aboutButton').addEventListener('click',()=>document.querySelector('#aboutModal').classList.add('open'));document.querySelector('#closeAbout').addEventListener('click',()=>document.querySelector('#aboutModal').classList.remove('open'));document.querySelector('#aboutModal').addEventListener('click',e=>{if(e.target.id==='aboutModal')e.currentTarget.classList.remove('open')});document.addEventListener('keydown',e=>{if(e.key==='Escape'){closeDrawer();document.querySelector('#aboutModal').classList.remove('open')}if(e.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();document.querySelector('#countrySearch').focus()}});window.addEventListener('resize',resizeMap);document.querySelectorAll('.news-list').forEach(el=>el.addEventListener('error',e=>{if(e.target.tagName==='IMG')e.target.style.visibility='hidden'},true));initMap();
