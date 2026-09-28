# Workshop review

## Before and after

Baseline: `0ad3ab9` on `main`. The HTTP root returned a plain status line. The engine was available through MCP and the CLI.

| Before | Workshop |
| --- | --- |
| ![Original HTTP root](before.png) | ![Desktop workshop](desktop.png) |

[Original response](before-response.txt) · [Tablet](tablet.png) · [Phone](phone.png) · [Exploded panels](exploded.png) · [Completed kit](kit-ready.png)

## Checked flows

The same engine generates all four template previews, assembly steps, part drawings and sheet layouts. The browser tests use separate test data and run these flows at 1440, 900 and 390 pixels wide:

- Change a bookcase to 740 W × 250 D × 1600 H mm, name it and save it.
- Inspect the exploded view, move to assembly step 2, choose a second sheet, and inspect hardware.
- Build a ZIP, download it, open `design.json`, and compare the saved name and dimensions.
- Refresh, open My designs, and restore the saved project.
- Recover an edited draft after refresh.
- Check invalid dimensions and a panel that exceeds its sheet; recover by selecting a suitable material.
- Switch between all four templates and operate preview tabs with the keyboard.

Each tested size fits the viewport width. Browser page-error checks pass. The in-app browser also completed a save/build/download flow: the 17-file ZIP for the alcove bookcase matched the full saved model.

## Engine and server checks

52 tests cover geometry, joinery, shelf sag, nesting, DXF, MCP and the browser API. New cases include partial revisions, a stale browser revision, a model revised during a build, overlapping build requests, package cleanup, failed nesting, invalid request bodies, foreign origins and hosts, path escapes and private quote records.

Crowded adjustable shelves now use distinct pin rows. The build gate checks panel overlap, holes within the panel and board thickness, and complete shelf quantities. Geometry checks also apply to models saved by earlier versions.

Build and TypeScript checks pass. An npm package inspection confirms that the workshop HTML, CSS and JavaScript ship beside the MCP and CLI entry points. CI runs the engine suite on Node 22 and 24 and the browser suite on Chromium; browser screenshots and failure traces are retained as workflow artifacts.

## Review boundaries

Measurements and sheet layouts come from the existing parametric model. Material colours are a visual guide. Load and stability checks remain estimates for review with the fabricator. The change is delivered as a pull request; production publishing and a package release are separate steps.
