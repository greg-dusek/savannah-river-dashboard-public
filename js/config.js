// Savannah River pilots dashboard: station list and default thresholds.
// Stations are ordered from sea to upriver, the order of an inbound transit.

const CONFIG = {
  refreshMinutes: 5,
  staleMinutes: 90, // an observation older than this is shown as stale
  steadyMinutes: 20, // water level is "steady" within this many minutes of predicted high or low water (about 0.05 ft of the turn)

  // Mean level of the tide predictions at the USGS gauges (js/tides.js). 'epoch' = 1983-2001 mean sea level,
  // the convention of NOAA's own predictions, so observed water now runs about 0.6 ft above the prediction
  // everywhere. 'recent' = the 2021-2026 mean of each gauge, which removes that offset at the USGS gauges only.
  tideMean: 'epoch',

  // Caution/alert limits (feet and knots). All unset: pilots enter their own on the page, and anything
  // left unset is not shown. Put numbers here only to ship a preset.
  thresholds: {
    windCaution: null, windAlert: null, currentCaution: null, currentAlert: null,
    wlHighCaution: null, wlHighAlert: null, wlLowCaution: null, wlLowAlert: null,
    airGapCaution: null, airGapAlert: null, workable: null
  },


  // NWS forecast grid cells (office/x,y) from api.weather.gov/points
  nwsGrids: { river: 'CHS/48,41', entrance: 'CHS/56,40' },
  nwsAlertPoints: ['32.08,-81.08', '32.03,-80.85'],

  // NOAA tidal current prediction points along the ship channel, sea to upriver.
  // type 'H' = harmonic station (full curve from NOAA). type 'S' = subordinate station: NOAA publishes only
  // slack and maximum times, and the dashboard draws a smooth curve between them.
  // `station` links a point to the dashboard station that already loads it; without it the point has its own row.
  currentPoints: [
    { id: 'SAV2302', type: 'H', bin: 4, depth: 23, lat: 31.9806, lon: -80.7514, name: 'Tybee approach, 5 nm E', survey: '2023 survey' },
    { id: 'SAV2306', type: 'H', bin: 10, depth: 13, lat: 32.0379, lon: -80.9043, name: 'Fort Pulaski, channel', survey: '2023 survey' },
    { id: 'SAV2311', station: 'elba', lat: 32.1002, lon: -80.9994, name: 'Elba Island, N of (LNG)', survey: '2023 survey' },
    { id: 'SAV2315', type: 'H', bin: 7, depth: 17, lat: 32.0851, lon: -81.0968, name: 'Talmadge Bridge, 0.25 nm S', survey: '2023 survey' }
  ],


  // The single sea-to-upriver list the page shows. Entries are station ids or 'cp:' + a current point id.
  // Points that belong to a station (see `station` above) appear through that station's row.
  order: ['buoy', 'cp:SAV2302', 'pulaski', 'cp:SAV2306', 'elba', 'usace', 'cp:SAV2315', 'gap:talmadge', 'garden', 'ga25', 'i95', 'clyo'],

  // Bridge air gap sensors. Each is its own place: a small circle on the map and a row in the list ('gap:' + id
  // in `order`). There is no air gap forecast, so at future times the row shows the latest reading.
  // A transit cannot start or end at one.
  airGaps: [
    {
      id: 'talmadge', coops: '8670674', lat: 32.0883, lon: -81.0990, name: 'Talmadge Bridge air gap',
      where: 'Talmadge Memorial Bridge', label: 'Talmadge Bridge',
      note: 'Clearance between the water surface and the air gap sensor on the Talmadge Memorial Bridge, from NOAA station 8670674. Observed only: there is no air gap forecast, so future times and Transit show the latest reading.'
    }
  ],

  // Which tidal current prediction a gauge's row and chart use. Only one is shown.
  // 'section' = the harmonic prediction of the USGS cross-section mean where the gauge measures velocity
  //             (like for like with the observation), NOAA's channel prediction where it does not (Elba Island).
  // 'noaa'    = NOAA's channel prediction wherever the station has one (`curPred`), otherwise the section mean.
  // January-October 2026 against the USGS observations: section mean 0.31 kt (Fort Pulaski) and 0.27 kt (USACE Dock)
  // RMS; NOAA's nearest channel point 0.55 and 0.42 kt, with slack 14-22 minutes later on average.
  stationCurrentPrediction: 'section',
  // Transit mode runs between these two places. Distances are straight-line chains between the listed
  // places, so they are approximate and slightly short of the true channel distance.
  route: { from: 'cp:SAV2302', to: 'ga25' },

  // `mllw` (feet) is added to the USGS gauge height to show water level above MLLW, 1983-2001 epoch. The numbers are
  // not typed here: they come from model/stations.json through js/stations.js and are copied on below this list.
  // Computed with NOAA's Tidal Analysis Datum Calculator v2.4.3 from each gauge's record, Fort Pulaski
  // (8670870) as control, monthly means simultaneous comparison, curve-fit picks after resampling to 6 minutes.
  // See model/run_tadc.py and model_data/datums/tadc_datums.csv. I-95 has no reliable tidal datum and stays in NAVD88.
  stations: [
    {
      id: 'buoy', name: 'Grays Reef buoy (41008)', short: '41008', lat: 31.40, lon: -80.866,
      where: 'Offshore, 40 nm SE of Savannah', buoy: 'gov-ndbc-41008', nws: 'entrance',
      note: 'Offshore wind and sea state. This feed has been running several hours behind real time.'
    },
    {
      id: 'pulaski', name: 'Fort Pulaski', short: 'Ft Pulaski', lat: 32.0347, lon: -80.9030,
      where: 'River entrance', coops: '8670870', coopsMet: '8670870', usgs: '02198980', nws: 'entrance',
      note: 'Water level and wind are from NOAA station 8670870. The current is the average across the river, measured by USGS gauge 02198980; the predicted current is for that same average.'
    },
    {
      id: 'elba', name: 'Elba Island (LNG)', short: 'Elba Is', lat: 32.1031, lon: -81.0069,
      where: 'LNG terminal reach', usgs: '0219897993', nws: 'river', focus: true,
      curPred: { id: 'SAV2311', lat: 32.1002, lon: -80.9994, bin: 7, depth: 16, name: 'Elba Island, N of (NOAA 2023 survey)' },
      note: 'No real-time current meter here. Current shown is the NOAA tidal prediction only; it does not include river flow or wind effects.'
    },
    {
      id: 'usace', name: 'Savannah, USACE Dock', short: 'Savannah', lat: 32.0804, lon: -81.0814,
      where: 'Downtown / Talmadge Bridge', usgs: '021989773', nws: 'river',
      note: 'The current is the average across the river, measured by USGS gauge 021989773; the predicted current is for that same average.'
    },
    {
      id: 'garden', name: 'Garden City', short: 'Garden City', lat: 32.1161, lon: -81.1283,
      where: 'Garden City Terminal', usgs: '021989715', nws: 'river',
      note: 'Water level only (USGS 021989715).'
    },
    {
      id: 'ga25', name: 'Port Wentworth (GA 25)', short: 'Pt Wentworth', lat: 32.1653, lon: -81.1549,
      where: 'Above the terminals', usgs: '02198920', nws: 'river',
      note: 'USGS gauge 02198920: water level, and current as the average across the river. The predicted current is for that same average.'
    },
    {
      id: 'i95', name: 'I-95 bridge', short: 'I-95', lat: 32.2355, lon: -81.1511,
      where: 'Upper tidal river', usgs: '02198840', nws: 'river',
      note: 'USGS gauge 02198840: water level, and current as the average across the river.'
    },
    {
      id: 'clyo', name: 'Clyo (river flow)', short: 'Clyo', lat: 32.5286, lon: -81.2683,
      where: 'Non-tidal, 61 river miles up', usgs: '02198500', flowOnly: true, nws: 'river',
      note: 'USGS 02198500: freshwater flow entering the tidal river. High flow strengthens ebb and weakens flood downstream.'
    }
  ]
};

// MLLW offsets for the USGS gauges, from js/stations.js (generated from model/stations.json).
for (const s of CONFIG.stations) {
  const m = typeof STATION_META !== 'undefined' && STATION_META[s.id];
  if (m && m.usgs === s.usgs) s.mllw = m.mllw;
}

// Upper river chart images used when zoomed out (see app.js): west, east and the latitude breaks.
CONFIG.chartCorridor = { west: -81.31, east: -81.09, lats: [32.07, 32.235, 32.40, 32.565], metersPerPixel: 9 };
