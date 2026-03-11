import type { EndpointMethod } from "../types/docs";

type MethodBadgeProps = {
  method: EndpointMethod;
};

export default function MethodBadge({ method }: MethodBadgeProps) {
  return <span className={`badge ${method === "GET" ? "get" : "post"}`}>{method}</span>;
}
