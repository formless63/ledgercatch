import "@/ui/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { appName } from "@/lib/app";
import { Options } from "./Options";

document.title = `${appName()} · Options`;
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<Options />
		</StrictMode>,
	);
}
