# v1.1

## New things!

Altitude filter: You can set a floor and a ceiling in feet and the envelope only draws that section.

Ground footprint: The major altitude rings now project onto the OpenStreetMap tiles so you can see where exactly your range drops off

Extend to top: This carries out the theoretical horizon to the top altitude band, so you can see what the "max" range could be for a perfect antenna. Enabling this will turn off the earth curvature though. (note to self later: would be cool to see the volume your antenna takes up of the max range)

Rebuilt side panel: I did not like the UI in the first version and found it hard to read and badly organized. This new UI is hopefully an improvement on your eyes and organizes sections more cleanly

Dev server: tools/devserver.py serves the viewer locally wtih live reload and proxies the receiver so you can modify the viewer or change the CSS in VS code using the launch config in `.vscode/`

Heat Footprint: If you've ever played Endless ATC, you know when you pause the game, there is a diffused heat footprint of the tracks the aircraft you controlled took to land. I would like to implement something like this so you can see the most common flight paths in your area, but for now I only have added the collector. It will accumulate data and when I finish the heat footprint viewer, there will already be data for you to see!


## Features I'm going to work on:

Heat Footprint, Plane size slider, More accurate aircraft models, Labels on the live aircraft (callsign, altitude, type), Better cell selection

If you have any ideas submit an issue or a PR!


## Updating

```
git pull
sudo ./install.sh
```


For Docker, rebuild the range3d service
