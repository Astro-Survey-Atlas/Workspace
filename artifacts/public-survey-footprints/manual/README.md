# Manual footprint submissions

Add manually calculated product footprints to `footprints.json` for review. Each entry must use an exact `surveyId`, `releaseId`, and `product` from `sources.json`, include the official source URL and a reproducible calculation method, and provide unique NESTED HEALPix pixels at NSIDE 16.

Example entry:

```json
{
  "surveyId": "example-survey",
  "releaseId": "example-release",
  "product": "Example product",
  "label": "Example release product coverage",
  "sourceUrl": "https://official.example/release",
  "method": "Converted official tile polygons to NESTED HEALPix NSIDE 16.",
  "calculatedAt": "2026-08-12T00:00:00.000Z",
  "pixels": [1, 2, 3]
}
```

Run `npm run artifacts:footprints` to validate submissions. Validation does not publish or load a manual footprint automatically; reviewed geometry must still be promoted into the canonical manifest and rebuilt resource package.
