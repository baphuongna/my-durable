# NOTICE — herdr adaptation

Presentation layer (layout/theme) adapted from herdr 0.4.0 interface study; license confirmation pending owner; fonts intentionally not bundled.

## Details

- Scope of adaptation: design tokens (color palette, radii, easing, shell sizing),
  the app-shell structure (top bar stats strip, three-column tree | inspector | chat
  workspace, mobile three-view nav, scrim/dialog, toast), and visual styling of
  existing components (see `src/style.css`, `src/components/TopBar.vue`,
  `MobileNav.vue`, `Toast.vue`, `HelpDialog.vue`).
- No herdr application code (store, fixtures, demo logic) was imported or ported;
  all data bindings remain on this client's own `src/client/store.ts`.
- herdr's bundled `woff2` font binaries (DM Sans / Manrope / IBM Plex Mono subsets)
  are intentionally NOT bundled here (OFL license confirmation pending owner). Fonts
  load via the existing Google Fonts CSS `@import` in `src/style.css`, with system
  font fallbacks in the `--font-*` custom properties.
- Reference copy (read-only): `bench/herdr-0.4.0-ref/` in the parent workspace.
