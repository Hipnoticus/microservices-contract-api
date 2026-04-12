/**
 * Treatment package value object.
 */
export class Package {
  constructor(
    public readonly id: number,
    public readonly name: string,
    public readonly sessions: number,
    public readonly price: number,
    public readonly originalPrice: number,
    public readonly discount: number,
    public readonly description: string,
    public readonly active: boolean,
  ) {}
}
