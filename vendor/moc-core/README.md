# Assets MOC Core runtime

The wheel in this directory is copied from the published
`Astro-Survey-Atlas-Assets` release artifact:

`artifacts/public-survey-footprints/moc-core/astro_survey_moc_core-1.0.0-py3-none-any.whl`

`requirements.lock` is the matching scientific dependency lock. Workspace
invokes the package through `python3 -m astro_survey_moc_core.cli`; it does not
implement an independent WCS, HEALPix, or MOC algorithm. Update this directory
only when the Assets Core contract and wheel are reviewed together.
