export const ORDER_QUERY = `#graphql
  query OrderForRelay($id: ID!) {
    order(id: $id) {
      id
      name
      email
      currencyCode
      totalPriceSet { shopMoney { amount currencyCode } }
      lineItems(first: 100) { nodes { sku title quantity } }
    }
  }
`;

export interface OrderQueryResult {
  order: {
    id: string;
    name: string;
    email: string | null;
    currencyCode: string;
    totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
    lineItems: { nodes: { sku: string | null; title: string; quantity: number }[] };
  } | null;
}
