export interface Controller<TInput, TOutput> {
  reconcile(input: TInput): Promise<TOutput>;
}