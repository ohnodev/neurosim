export type Route = "/";

export type EndpointMethod = "GET" | "POST";
export type EndpointSection = "market" | "trade" | "dashboard" | "health";

export type CodeTab = {
  key: string;
  label: string;
  language: string;
  content: string;
  iconSrc?: string;
  iconAlt?: string;
  iconOnly?: boolean;
};

export type EndpointBlock = {
  id: string;
  section: EndpointSection;
  method: EndpointMethod;
  path: string;
  summary: string;
  tabs: CodeTab[];
  tryUrl?: string;
};

export type NavLink = {
  id: string;
  label: string;
};
