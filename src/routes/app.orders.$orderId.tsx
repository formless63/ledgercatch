import { createFileRoute } from "@tanstack/react-router";
import { OrderDetailPage } from "#/components/orders/order-detail-page";

export const Route = createFileRoute("/app/orders/$orderId")({
	component: OrderRoute,
});

function OrderRoute() {
	const { orderId } = Route.useParams();
	return <OrderDetailPage key={orderId} orderId={orderId} />;
}
