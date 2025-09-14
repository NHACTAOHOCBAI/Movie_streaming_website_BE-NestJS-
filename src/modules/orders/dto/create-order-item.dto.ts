import { NumberRequired } from "src/decorators/dto.decorator";

export class CreateOrderItemDto {
  @NumberRequired('Varint ID')
  variantId: number

  @NumberRequired('quantity')
  quantity: number
}