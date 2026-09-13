# 3D models shipped with the portal

## `upper-arch.glb`

The arch turning inside the hero diagram on both dashboards.

| | |
|---|---|
| Source | NIH 3D, entry **3DPX-003002**, "Upper dental tooth model" — <https://3d.nih.gov/entries/3002> |
| Author | Michael D Scherer, DMD, MS, FACP — Diplomate, American Board of Prosthodontics |
| Licence | **CC0 1.0** (public domain dedication) — no attribution required; credited here anyway |
| Original | `Maxillary_teeth_w_base_NIH3D.glb`, 34 MB, 1,902,630 triangles |
| Shipped | 39,776 triangles, ~760 KB |

### How it was reduced

The original is a print-quality scan: far more mesh than a decoration a few
hundred pixels wide can show. It was reduced by vertex clustering on a
100-cell grid (snap each vertex to a cell, keep the cell's average, drop the
faces that collapse), then centred on the origin and scaled to two units
across its widest axis so the camera in `ArchSpin.tsx` needs no per-model
adjustment. Nothing about the geometry is claimed to be clinically accurate at
this resolution — it is scenery, not a scan anyone plans from.
