import { ProjectDefinition } from "../src/index";

export function makeProject(overrides: Partial<ProjectDefinition> = {}): ProjectDefinition {
  return {
    initialScreen: "home",
    variables: [],
    screens: [{ name: "home", rules: [] }],
    ...overrides,
  };
}
