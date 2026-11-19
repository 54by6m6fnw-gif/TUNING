# TUNING

A tuning assistant for Holley Terminator X ECUs on LS engines. It runs in the browser. Logs and tables stay on your computer and are never uploaded.

The app does not connect to the ECU. Holley EFI software still reads and writes the tune. You move data between the two with CSV datalog exports and copy and paste of tables.

## Features

- **VE correction:** compares measured AFR to target AFR in a datalog, including closed loop comp and learn, and builds a corrected VE table. It filters out cold, transient and decel data, lines up wideband lag, and limits how much each cell can change.
- **Base map:** starting VE, ignition timing and target AFR tables from displacement, cam, heads, compression, fuel and boost.
- **Knock and timing:** shows where knock retard happened by RPM and MAP, lists each event, and suggests a timing table with timing pulled in those cells.
- **Log viewer:** synced, zoomable charts of any channels in the log.

## Run it

It is a static site with no build step. Serve the folder with any web server:

```
python -m http.server 8080
```

Then open http://localhost:8080. Click **Try sample data** to see it work with a made-up log.

## Tests

```
npm test
```

## Layout

- `js/core.js`: log parsing, table handling, VE correction and knock math (no DOM, tested in Node)
- `js/basemap.js`: base map builder
- `js/sample.js`: made-up sample log
- `js/app.js`: user interface
- `vendor/`: uPlot charting library (MIT)

## Planned

- 4L60E / 4L80E shift table review and correction (Terminator X Max)
- ZF 8HP transmission platform
