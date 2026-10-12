/* map-mieru — all personal records and imported location history stay in this browser. */
(() => {
  "use strict";

  const SOURCE_REV = "58c561b557eab3a08ee7aa17b6837bcd789cdf43";
  const MAP_DATA_ROOT = `https://cdn.jsdelivr.net/gh/ricewin/simplify-japan-geojson@${SOURCE_REV}/TopoJson/`;
  const STORAGE_KEY = "map-mieru:visits:v1";
  const PREFECTURES = [
    "北海道","青森県","岩手県","宮城県","秋田県","山形県","福島県","茨城県","栃木県","群馬県",
    "埼玉県","千葉県","東京都","神奈川県","新潟県","富山県","石川県","福井県","山梨県","長野県",
    "岐阜県","静岡県","愛知県","三重県","滋賀県","京都府","大阪府","兵庫県","奈良県","和歌山県",
    "鳥取県","島根県","岡山県","広島県","山口県","徳島県","香川県","愛媛県","高知県","福岡県",
    "佐賀県","長崎県","熊本県","大分県","宮崎県","鹿児島県","沖縄県"
  ];
  // N03 contains seven unassigned-land polygons and six northern-island villages that
  // aren't counted in the standard domestic 1,741-municipality statistics.
  const EXCLUDED = new Set(["01695","01696","01697","01698","01699","01700"]);
  const el = (id) => document.getElementById(id);
  const codeOf = (f) => String(f?.properties?.N03_007 || "");
  const prefOf = (code) => code.slice(0, 2);
  const prefName = (code) => PREFECTURES[Number(code) - 1] || "不明";
  const validCode = (code) => /^\d{5}$/.test(code) && !code.endsWith("000") && !EXCLUDED.has(code);
  const percent = (part, all) => all ? (part / all * 100) : 0;
  const formatPct = (part, all) => percent(part, all).toFixed(1);

  let records = readStorage();
  let topology = null;
  let nationwide = [];
  let allCodes = new Set();
  let byPref = new Map();
  let regionCache = new Map();
  let regionPromises = new Map();
  let currentPref = null;
  let mapZoom = null;
  let svgG = null;
  let pendingTimeline = [];
  let toastTimer = null;

  function readStorage() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      if (!parsed || typeof parsed !== "object") return {};
      const source = parsed.visited && typeof parsed.visited === "object" ? parsed.visited : {};
      return Object.fromEntries(Object.entries(source).filter(([code, value]) => /^\d{5}$/.test(code) && Boolean(value)));
    } catch {
      return {};
    }
  }
  function saveStorage() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({version: 1, visited: records}));
      return true;
    } catch {
      notice("保存できません。ブラウザの空き容量・保存設定を確認してください。");
      return false;
    }
  }
  function notice(message) {
    const node = el("toast");
    node.textContent = message;
    node.classList.add("show");
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => node.classList.remove("show"), 3200);
  }
  function newNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function countForPref(code) {
    const list = byPref.get(code) || [];
    return {all: list.length, visited: list.filter(f => Boolean(records[codeOf(f)])).length};
  }
  function allVisited() {
    return Object.keys(records).filter(code => allCodes.has(code)).length;
  }
  function refreshStats() {
    const done = allVisited();
    el("visitedCount").textContent = done.toLocaleString("ja-JP");
    el("visitedTotal").textContent = " / " + nationwide.length.toLocaleString("ja-JP");
    el("nationalRate").textContent = formatPct(done, nationwide.length);
    el("nationalBar").style.width = percent(done, nationwide.length) + "%";
    el("prefVisitedCount").textContent = [...byPref.keys()].filter(code => countForPref(code).visited > 0).length;
  }

  async function fetchTopology(filename) {
    const response = await fetch(MAP_DATA_ROOT + filename, {cache: "force-cache"});
    if (!response.ok) throw new Error(`地図データの取得エラー (HTTP ${response.status})`);
    return response.json();
  }
  async function getRegion(code) {
    if (regionCache.has(code)) return regionCache.get(code);
    if (regionPromises.has(code)) return regionPromises.get(code);
    const promise = (async () => {
      const geo = await fetchTopology(code + ".json");
      const collection = Object.values(geo.objects)[0];
      const features = topojson.feature(geo, collection).features.filter(f => validCode(codeOf(f)));
      const result = features.map(f => {
        f.properties.displayName = f.properties.N03_004 || "名称未登録";
        return f;
      });
      regionCache.set(code, result);
      return result;
    })();
    regionPromises.set(code, promise);
    try { return await promise; }
    finally { regionPromises.delete(code); }
  }
  async function loadMap() {
    el("mapError").hidden = true;
    el("mapLoading").hidden = false;
    el("map").hidden = true;
    try {
      if (!window.d3 || !window.topojson) throw new Error("地図ライブラリを読み込めませんでした");
      topology = await fetchTopology("prefecture.json");
      const collection = topology.objects.prefecture;
      nationwide = topojson.feature(topology, collection).features.filter(f => validCode(codeOf(f)));
      if (nationwide.length !== 1741) throw new Error(`想定外の自治体数です (${nationwide.length}件)。地図データの更新が必要です`);
      allCodes = new Set(nationwide.map(codeOf));
      byPref = new Map(Array.from({length: 47}, (_, i) => [String(i + 1).padStart(2,"0"), []]));
      for (const f of nationwide) byPref.get(prefOf(codeOf(f))).push(f);
      el("mapLoading").hidden = true;
      el("map").hidden = false;
      refreshStats();
      renderPrefList();
      renderMap(nationwide, false);
    } catch (err) {
      console.error(err);
      el("mapLoading").hidden = true;
      el("mapError").hidden = false;
      el("mapError").querySelector("span").textContent = String(err.message || err);
    }
  }
  function setMapTitle() {
    const selected = Boolean(currentPref);
    el("breadcrumbCurrent").hidden = !selected;
    el("breadcrumbCurrent").textContent = selected ? prefName(currentPref) : "";
    el("mapHeading").textContent = selected ? prefName(currentPref) + "の訪問マップ" : "日本全国の訪問マップ";
    el("mapHelp").textContent = selected
      ? "市区町村をタップすると、訪問済み／未訪問を切り替えられます。"
      : "都道府県をタップすると、市区町村を塗れます。";
  }
  async function selectPref(code) {
    if (!byPref.has(code)) return;
    currentPref = code;
    el("prefOverview").hidden = true;
    el("municipalityOverview").hidden = false;
    el("citySearch").value = "";
    el("prefName").textContent = prefName(code);
    el("cityList").replaceChildren(newNode("p", "empty-hint", "市区町村データを読み込んでいます…"));
    setMapTitle();
    refreshPrefProgress();
    el("map").hidden = true;
    el("mapLoading").hidden = false;
    try {
      const features = await getRegion(code);
      if (currentPref !== code) return;
      el("mapLoading").hidden = true;
      el("map").hidden = false;
      renderMap(features, true);
      renderCityList();
    } catch (err) {
      if (currentPref !== code) return;
      el("mapLoading").hidden = true;
      el("mapError").hidden = false;
      el("mapError").querySelector("span").textContent = String(err.message || err);
      el("cityList").replaceChildren(newNode("p", "empty-hint", "データを読み込めませんでした。再読み込みしてください。"));
    }
  }
  function showAllJapan() {
    if (!nationwide.length) return;
    currentPref = null;
    el("mapError").hidden = true;
    el("mapLoading").hidden = true;
    el("map").hidden = false;
    el("prefOverview").hidden = false;
    el("municipalityOverview").hidden = true;
    setMapTitle();
    renderPrefList();
    renderMap(nationwide, false);
  }
  function renderMap(features, isRegion) {
    const svg = d3.select(el("map"));
    svg.selectAll("*").remove();
    const fc = {type: "FeatureCollection", features};
    const projection = d3.geoMercator().fitExtent([[38, 34], [862, 569]], fc);
    const path = d3.geoPath(projection);
    svgG = svg.append("g");
    svgG.selectAll("path.map-region").data(features, codeOf).join("path")
      .attr("class", f => "map-region " + (records[codeOf(f)] ? "visited" : "not-visited"))
      .attr("d", path)
      .attr("stroke", "#fff")
      .attr("stroke-width", isRegion ? 1.1 : 0.24)
      .attr("tabindex", isRegion ? 0 : null)
      .attr("role", isRegion ? "button" : null)
      .attr("aria-label", f => isRegion ? `${f.properties.displayName}：${records[codeOf(f)] ? "訪問済み" : "未訪問"}` : prefName(prefOf(codeOf(f))))
      .each(function(f) {
        d3.select(this).append("title").text(isRegion ? (f.properties.displayName + "：タップして切り替え") : (prefName(prefOf(codeOf(f))) + "を表示"));
      })
      .on("click", (event, f) => {
        if (event.defaultPrevented) return;
        const code = codeOf(f);
        if (isRegion) toggleCity(code);
        else selectPref(prefOf(code));
      })
      .on("keydown", (event, f) => {
        if (isRegion && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); toggleCity(codeOf(f)); }
      });
    if (!isRegion) {
      svgG.append("path")
        .attr("class", "pref-outline")
        .attr("d", path(topojson.mesh(topology, topology.objects.prefecture, (a,b) => a.properties.N03_001 !== b.properties.N03_001)));
    }
    mapZoom = d3.zoom().scaleExtent([1, 12]).on("zoom", event => svgG.attr("transform", event.transform));
    svg.call(mapZoom).on("dblclick.zoom", null);
    svg.call(mapZoom.transform, d3.zoomIdentity);
  }
  function updateMapColors() {
    if (!svgG) return;
    svgG.selectAll(".map-region")
      .attr("class", f => "map-region " + (records[codeOf(f)] ? "visited" : "not-visited"))
      .attr("aria-label", f => currentPref ? `${f.properties.displayName}：${records[codeOf(f)] ? "訪問済み" : "未訪問"}` : prefName(prefOf(codeOf(f))));
  }
  function toggleCity(code) {
    if (!allCodes.has(code)) return;
    if (records[code]) delete records[code];
    else records[code] = {source: "manual", recordedAt: new Date().toISOString()};
    saveStorage();
    updateMapColors();
    refreshStats();
    refreshPrefProgress();
    renderCityList();
  }
  function refreshPrefProgress() {
    if (!currentPref) return;
    const stat = countForPref(currentPref);
    el("prefRate").textContent = formatPct(stat.visited, stat.all) + "%";
    el("prefProgressText").textContent = stat.visited + " / " + stat.all + " 市区町村";
    el("prefProgressBar").style.width = percent(stat.visited, stat.all) + "%";
  }
  function renderPrefList() {
    const list = el("prefList");
    const rows = [...byPref.keys()].map(code => ({code, ...countForPref(code)}));
    const order = el("sortPref").value;
    if (order === "rate") rows.sort((a,b) => percent(b.visited,b.all) - percent(a.visited,a.all) || a.code.localeCompare(b.code));
    if (order === "visited") rows.sort((a,b) => b.visited - a.visited || a.code.localeCompare(b.code));
    const frag = document.createDocumentFragment();
    rows.forEach(({code, all, visited}) => {
      const button = newNode("button","pref-item");
      button.type = "button";
      button.setAttribute("aria-label", `${prefName(code)}、${visited}/${all}、制覇率${formatPct(visited,all)}%。詳細を見る`);
      const head = newNode("div", "");
      head.append(newNode("span", "pref-item-name", prefName(code)), newNode("div", "pref-item-count", `${visited} / ${all} 市区町村`));
      button.append(head, newNode("span", "pref-item-rate", formatPct(visited,all) + "%"));
      const bar = newNode("div","pref-item-bar");
      const fill = newNode("span","");
      fill.style.width = percent(visited,all) + "%";
      bar.append(fill); button.append(bar);
      button.addEventListener("click", () => selectPref(code));
      frag.append(button);
    });
    list.replaceChildren(frag);
  }
  function renderCityList() {
    if (!currentPref) return;
    const list = el("cityList");
    const term = el("citySearch").value.trim().toLocaleLowerCase("ja");
    const features = regionCache.get(currentPref) || [];
    const filtered = features.filter(f => f.properties.displayName.toLocaleLowerCase("ja").includes(term) || codeOf(f).includes(term));
    const frag = document.createDocumentFragment();
    filtered.sort((a,b) => Number(Boolean(records[codeOf(b)])) - Number(Boolean(records[codeOf(a)])) || codeOf(a).localeCompare(codeOf(b)));
    for (const f of filtered) {
      const code = codeOf(f), checked = Boolean(records[code]);
      const button = newNode("button", "city-row" + (checked ? " is-visited" : ""));
      button.type = "button";
      button.setAttribute("aria-pressed", checked ? "true" : "false");
      const wrapper = newNode("span", "");
      wrapper.append(newNode("span", "city-name", f.properties.displayName), newNode("span", "city-code", code));
      button.append(wrapper, newNode("span","city-check", checked ? "✓" : "＋"));
      button.addEventListener("click", () => toggleCity(code));
      frag.append(button);
    }
    if (!filtered.length) frag.append(newNode("p", "empty-hint", "該当する市区町村がありません。"));
    list.replaceChildren(frag);
  }

  function downloadBackup() {
    if (!nationwide.length) return notice("地図の読み込み完了後に操作してください。");
    const data = {app:"map-mieru",version:1,exportedAt:new Date().toISOString(),visited:Object.fromEntries(Object.entries(records).filter(([c])=>allCodes.has(c)))};
    const blob = new Blob([JSON.stringify(data,null,2)], {type:"application/json;charset=utf-8"});
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href=url; link.download="map-mieru-"+new Date().toISOString().slice(0,10)+".json";
    document.body.append(link);link.click();link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),10000);
    notice("バックアップをダウンロードしました。");
  }
  async function restoreBackup(file) {
    if (!file || !nationwide.length) return;
    try {
      const json = JSON.parse(await file.text());
      if (json.app !== "map-mieru" || json.version !== 1 || !json.visited || typeof json.visited !== "object" || Array.isArray(json.visited)) {
        throw new Error("map-mieruのバックアップJSONではありません。");
      }
      const entries = Object.entries(json.visited).filter(([c,v])=>allCodes.has(c) && Boolean(v));
      if (!entries.length) return notice("取り込める訪問記録がありませんでした。");
      const added = entries.filter(([c])=>!records[c]).length;
      if (!window.confirm(`${entries.length}件の訪問記録を現在の記録に追加・統合します（新規 ${added}件）。よろしいですか？`)) return;
      for (const [code, value] of entries) {
        if (!records[code]) records[code] = typeof value === "object" ? value : {source:"backup"};
      }
      saveStorage();refreshStats();updateMapColors();refreshPrefProgress();renderPrefList();renderCityList();
      notice(`${added}件の訪問記録を追加しました。`);
    } catch (e) { notice(e.message || "ファイルの読み込みに失敗しました。"); }
  }
  function parseLatLng(raw) {
    if (typeof raw === "object" && raw) raw = raw.latLng || raw.LatLng || raw.point || "";
    if (typeof raw !== "string") return null;
    const m = raw.match(/-?\d+(?:\.\d+)?/g);
    if (!m || m.length !== 2) return null;
    const lat=Number(m[0]), lng=Number(m[1]);
    return Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat)<=90 && Math.abs(lng)<=180 ? [lng,lat] : null;
  }
  function bboxOfGeometry(geometry) {
    const b = [Infinity,Infinity,-Infinity,-Infinity];
    function visit(value) {
      if (!Array.isArray(value)) return;
      if (typeof value[0] === "number" && typeof value[1] === "number") {
        b[0]=Math.min(b[0],value[0]);b[1]=Math.min(b[1],value[1]);
        b[2]=Math.max(b[2],value[0]);b[3]=Math.max(b[3],value[1]);
      } else value.forEach(visit);
    }
    visit(geometry.coordinates);
    return b;
  }
  function pointInRing(p, ring) {
    let inside = false;
    for (let i=0,j=ring.length-1;i<ring.length;j=i++) {
      const a=ring[i],b=ring[j];
      if ((a[1]>p[1]) !== (b[1]>p[1]) && p[0] < (b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1]) + a[0]) inside=!inside;
    }
    return inside;
  }
  function pointInPoly(p, rings) {
    return rings.length>0 && pointInRing(p,rings[0]) && !rings.slice(1).some(hole=>pointInRing(p,hole));
  }
  function containsPoint(feature,p) {
    const geom = feature.geometry;
    if (!geom) return false;
    if (geom.type==="Polygon") return pointInPoly(p,geom.coordinates);
    if (geom.type==="MultiPolygon") return geom.coordinates.some(polygon=>pointInPoly(p,polygon));
    return false;
  }
  function makeIndex(features) {return features.map(f=>({feature:f,bbox:bboxOfGeometry(f.geometry)}));}
  function findPoint(index,p) {
    for (const e of index) {
      const b=e.bbox;
      if (p[0]<b[0] || p[0]>b[2] || p[1]<b[1] || p[1]>b[3]) continue;
      if (containsPoint(e.feature,p)) return e.feature;
    }
    return null;
  }
  async function importTimeline(file) {
    if (!file || !nationwide.length) return;
    const status=el("timelineStatus");
    el("timelinePreview").hidden = true;
    pendingTimeline = [];
    if (file.size>120*1024*1024) {
      status.textContent="ファイルが120MBを超えています。現在の試験版では対応していません。";
      return;
    }
    try {
      status.textContent = "JSONを端末内で解析しています…";
      await new Promise(resolve=>setTimeout(resolve,40));
      const input = JSON.parse(await file.text());
      const segments = Array.isArray(input) ? input : input.semanticSegments;
      if (!Array.isArray(segments)) throw new Error("未対応のタイムライン形式です。semanticSegments形式または訪問セグメントの配列を利用してください。");
      const visits=[];
      for (const seg of segments) {
        const place=seg?.visit?.topCandidate?.placeLocation;
        if (!place) continue; // Routes / raw GPS points deliberately excluded.
        const p = parseLatLng(place);
        if (!p || p[0]<121 || p[0]>155 || p[1]<20 || p[1]>47) continue;
        const start=Date.parse(seg.startTime), end=Date.parse(seg.endTime);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end-start<5*60*1000) continue;
        visits.push({p,start});
      }
      if (!visits.length) {
        status.textContent=`${segments.length.toLocaleString()}件のデータを確認しましたが、日本国内で5分以上滞在した地点を抽出できませんでした。`;
        return;
      }
      status.textContent=`${visits.length.toLocaleString()}件の滞在地点から市区町村を判定しています…`;
      await new Promise(resolve=>setTimeout(resolve,40));
      const roughIndex = makeIndex(nationwide);
      const prelim = visits.map(v=>({...v,rough:findPoint(roughIndex,v.p)})).filter(v=>v.rough);
      const prefCodes = [...new Set(prelim.map(v=>prefOf(codeOf(v.rough))))];
      const regions = new Map(), failed=[];
      for (const code of prefCodes) {
        status.textContent=`市区町村の境界を照合中… (${regions.size+failed.length+1}/${prefCodes.length}都道府県)`;
        try { regions.set(code,makeIndex(await getRegion(code))); }
        catch(e) { console.warn("Prefecture data could not be fetched:",code,e);failed.push(code); }
      }
      const matches = new Map();
      let unmatched = visits.length - prelim.length;
      for (const v of prelim) {
        const prefCode = prefOf(codeOf(v.rough));
        const matching=regions.has(prefCode) ? findPoint(regions.get(prefCode),v.p) : null;
        if (!matching) {unmatched++;continue;}
        const code=codeOf(matching);
        if (!matches.has(code)) matches.set(code,{code,name:matching.properties.displayName,pref:prefName(prefCode),times:0});
        matches.get(code).times++;
      }
      pendingTimeline=[...matches.values()].sort((a,b)=>b.times-a.times || a.code.localeCompare(b.code));
      if (!pendingTimeline.length) {
        status.textContent="滞在地点を市区町村に対応付けられませんでした。境界付近や離島の記録は手動登録をお試しください。";
        return;
      }
      status.textContent=`滞在記録 ${visits.length}件 → 市区町村 ${pendingTimeline.length}件を候補として抽出しました。判定できなかった地点：${unmatched}件。${failed.length ? "一部地域のデータ読み込みに失敗しました。" : ""} 登録前に確認してください。`;
      renderTimelinePreview();
    } catch(e) {
      console.error(e);status.textContent=e.message || "タイムラインを解析できませんでした。";
    }
  }
  function renderTimelinePreview() {
    const list=el("previewList"),frag=document.createDocumentFragment();
    for (const item of pendingTimeline) {
      const label=newNode("label","preview-row");
      const checkbox=document.createElement("input");
      checkbox.type="checkbox";checkbox.value=item.code;checkbox.checked=!records[item.code];
      label.append(checkbox,newNode("span","",item.pref + " " + item.name),newNode("small","",item.times + "回"));
      frag.append(label);
    }
    list.replaceChildren(frag);
    el("previewHeading").textContent="訪問候補："+pendingTimeline.length+"市区町村";
    el("timelinePreview").hidden=false;
  }
  function applyTimeline() {
    const checked=[...el("previewList").querySelectorAll('input[type="checkbox"]:checked')].map(x=>x.value);
    let added=0;
    for (const code of checked) {
      if (!allCodes.has(code) || records[code]) continue;
      records[code]={source:"timeline",recordedAt:new Date().toISOString()};
      added++;
    }
    saveStorage();refreshStats();updateMapColors();refreshPrefProgress();renderPrefList();renderCityList();
    el("timelinePreview").hidden=true;pendingTimeline=[];
    el("timelineStatus").textContent=`新たに${added}市区町村を訪問済みに登録しました。元の位置情報は保存していません。`;
    notice(`${added}市区町村の訪問記録を追加しました。`);
  }

  function setupEvents() {
    el("sortPref").addEventListener("change",renderPrefList);
    el("citySearch").addEventListener("input",renderCityList);
    el("allJapan").addEventListener("click",showAllJapan);
    el("backToAll").addEventListener("click",showAllJapan);
    el("resetZoom").addEventListener("click",()=>{if (mapZoom) d3.select(el("map")).transition().duration(250).call(mapZoom.transform,d3.zoomIdentity);});
    el("retryLoad").addEventListener("click",()=>location.reload());
    const dialog=el("dataDialog");
    const open=()=>dialog.showModal();
    el("openData").addEventListener("click",open);
    el("openDataBottom").addEventListener("click",open);
    el("closeDialog").addEventListener("click",()=>dialog.close());
    dialog.addEventListener("click",e=>{if(e.target===dialog) dialog.close();});
    el("exportData").addEventListener("click",downloadBackup);
    el("importData").addEventListener("change",async e=>{const file=e.target.files?.[0];e.target.value="";await restoreBackup(file);});
    el("timelineInput").addEventListener("change",async e=>{const file=e.target.files?.[0];e.target.value="";await importTimeline(file);});
    el("selectAllPreview").addEventListener("click",()=>el("previewList").querySelectorAll('input[type="checkbox"]').forEach(x=>x.checked=true));
    el("deselectAllPreview").addEventListener("click",()=>el("previewList").querySelectorAll('input[type="checkbox"]').forEach(x=>x.checked=false));
    el("applyTimeline").addEventListener("click",applyTimeline);
  }
  setupEvents();
  loadMap();
})();