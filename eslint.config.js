import js from "@eslint/js";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import eslintConfigPrettier from "eslint-config-prettier";

export default [
	{
		ignores: ["**/node_modules/**", "**/dist/**", "bun.lock", "package-lock.json"],
	},
	js.configs.recommended,
	{
		files: ["src/**/*.ts", "src/**/*.tsx"],
		languageOptions: {
			parser: tsParser,
			ecmaVersion: "latest",
			sourceType: "module",
		},
		plugins: {
			"@typescript-eslint": tsPlugin,
		},
		rules: {
			...tsPlugin.configs.recommended.rules,
			// TypeScript already reports undeclared variables (incl. DOM types in evaluate() callbacks).
			"no-undef": "off",
		},
	},
	eslintConfigPrettier,
];
