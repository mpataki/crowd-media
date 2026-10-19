// Vite's `?raw` suffix: import a file's text (used to feed YAML fixtures to the validator).
declare module "*?raw" {
  const text: string;
  export default text;
}
