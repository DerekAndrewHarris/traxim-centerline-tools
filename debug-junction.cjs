const fs = require('fs');
const sd = 'C:/Users/derek/AppData/Local/Temp/traxim-temp-sessions/9cbcd653-43df-4dba-9665-fdf167c9e570';
const topo = JSON.parse(fs.readFileSync(sd + '/osm_topology.json', 'utf8'));

// Find the key junction node IDs by matching coords
const junctionCoords = [
  { lat: 43.6618204, lon: 10.3697475, label: 'NW' },
  { lat: 43.6611918, lon: 10.3693559, label: 'SW1' },
  { lat: 43.6611541, lon: 10.3694061, label: 'SW2' },
  { lat: 43.6618476, lon: 10.3696924, label: 'NE' },
  { lat: 43.661625,  lon: 10.3696452, label: 'MID' },
];

// Build node-to-ways map
const nodeToWays = {};
for (const w of topo.ways) {
  for (const nid of w.nodes) {
    if (!nodeToWays[nid]) nodeToWays[nid] = [];
    nodeToWays[nid].push(w.id);
  }
}

// Find junction nodes (nodes shared by multiple ways)
const wayIds = [214215546, 235285328, 235285759, 307185072, 389540854, 
                1029862640, 1029862642, 1029862650, 1038313787, 1038313788];

console.log('=== JUNCTION WAYS AND THEIR ENDPOINTS ===');
for (const wid of wayIds) {
  const w = topo.ways.find(x => x.id === wid);
  if (!w) continue;
  const first = w.coords[0], last = w.coords[w.coords.length-1];
  const firstNode = w.nodes[0], lastNode = w.nodes[w.nodes.length-1];
  const firstDeg = nodeToWays[firstNode] ? nodeToWays[firstNode].length : 0;
  const lastDeg = nodeToWays[lastNode] ? nodeToWays[lastNode].length : 0;
  console.log(`Way ${wid}: ${w.coords.length} coords`);
  console.log(`  start: node ${firstNode} (${first.lat},${first.lon}) deg=${firstDeg}`);
  console.log(`  end:   node ${lastNode} (${last.lat},${last.lon}) deg=${lastDeg}`);
}

// Now check which sections contain which ways
console.log('\n=== SECTION ASSIGNMENTS ===');
const geoDir = sd + '/geometry/';
const geoFiles = fs.readdirSync(geoDir).filter(f => f.endsWith('_wayids.csv'));
for (const gf of geoFiles) {
  const lines = fs.readFileSync(geoDir + gf, 'utf8').trim().split('\n').slice(1);
  const wids = lines.map(l => parseInt(l.split(',')[1]));
  const matching = wayIds.filter(wid => wids.includes(wid));
  if (matching.length > 0) {
    console.log(`${gf}: contains ways ${matching.join(', ')}`);
  }
}

// Check alt geometry files - do they have wayid files?
const altFiles = fs.readdirSync(geoDir).filter(f => f.includes('alt') && f.endsWith('.csv') && !f.includes('wayid'));
console.log('\nAlt geometry files:', altFiles.join(', '));
const altWayidFiles = fs.readdirSync(geoDir).filter(f => f.includes('alt') && f.includes('wayid'));
console.log('Alt wayid files:', altWayidFiles.length > 0 ? altWayidFiles.join(', ') : 'NONE');

// Check what geometry files we have for the main section
const mainGeo = fs.readFileSync(geoDir + 'Livorno_Centrale_-_Pisa_wayids.csv', 'utf8').trim().split('\n');
console.log('\nMainline wayids CSV rows:', mainGeo.length);

// Find which way IDs in mainline match our junction ways
const mainWayIds = mainGeo.slice(1).map(l => parseInt(l.split(',')[1]));
console.log('Junction ways in mainline:', wayIds.filter(wid => mainWayIds.includes(wid)));

