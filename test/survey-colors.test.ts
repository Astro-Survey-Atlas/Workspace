import assert from "node:assert/strict";
import test from "node:test";

import { fallbackSurveyColor, surveyColorFor, surveyDisplayColor } from "../src/survey-colors.js";

test("survey colors preserve valid catalog values", () => {
  assert.equal(surveyColorFor("euclid", "#3B82F6"), "#3b82f6");
});

test("survey colors replace generic blue fallbacks deterministically", () => {
  const first = fallbackSurveyColor("unclassified-survey");
  assert.equal(surveyColorFor("unclassified-survey", "#376b9b"), first);
  assert.equal(surveyColorFor("unclassified-survey", undefined), first);
  assert.equal(fallbackSurveyColor("unclassified-survey"), first);
  assert.notEqual(first, "#376b9b");
});

test("survey display colors match the sky renderer contrast transform", () => {
  assert.equal(surveyDisplayColor("euclid", "#a7d9ff"), "#2caee9");
  assert.equal(surveyDisplayColor("sdss", "#95dc9b"), "#56e067");
});
