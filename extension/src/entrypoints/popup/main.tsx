import "@/ui/styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { appName } from "@/lib/app";
import { App } from "./App";

document.title = appName();
const root = document.getElementById("root");
if (root) {
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>,
	);
}
