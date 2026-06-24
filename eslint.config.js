import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const vitalsWithReactVersion = nextVitals.map((config) => ({
  ...config,
  settings: {
    ...config.settings,
    // Pin react version explicitly so eslint-plugin-react does not call
    // the ESLint 9 getFilename() API, which was removed in ESLint 10.
    react: { version: "19.2.7" },
  },
}));

const config = [
  ...vitalsWithReactVersion,
  ...nextTs,
  {
    files: ["app/**/*.{ts,tsx}"],
    rules: {
      // Server-only env (incl. the service-role key) is read in lib/, never app/.
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "@/lib/env", message: "Read server-only env in lib/, not app/." }] },
      ],
    },
  },
  { ignores: [".next/", "node_modules/", "supabase/.branches/", ".remember/", ".superpowers/"] },
];

export default config;
