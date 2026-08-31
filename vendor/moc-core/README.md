# Astro Survey MOC Core runtime

The wheel in this directory is the transitional pinned distribution from the
organization-level Core repository:

`https://github.com/Astro-Survey-Atlas/MOC-Core-SDK@2ebc395`

`requirements.lock` is the matching scientific dependency lock. Workspace
invokes the package through `python3 -m astro_survey_moc_core.cli`; it does not
implement an independent WCS, HEALPix, or MOC algorithm. Update this directory
only when the Core contract and wheel are reviewed together. The current wheel
SHA-256 is `66d0d07c3afaf74141f967c80eaf359180d06a07f6805494a4aea086d6339642`.
