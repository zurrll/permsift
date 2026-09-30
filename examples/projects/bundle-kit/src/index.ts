export interface Item { price: number; quantity: number }
export const total = (items: Item[]): number => items.reduce((sum, item) => sum + item.price * item.quantity, 0);
