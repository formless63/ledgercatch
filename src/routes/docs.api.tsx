import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/docs/api")({ component: ApiDocsPage });

function ApiDocsPage() {
	return (
		<ApiReferenceReact
			configuration={{
				url: "/api/openapi.json",
				theme: "default",
			}}
		/>
	);
}
