import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { Order, OrderItem } from './entities';
import { DataSource, Like, Repository } from 'typeorm';
import { CreateOrderDto } from './dto/create-order.dto';
import { User } from '../users/entities/user.entity';
import { Cart, CartItem } from '../carts/entities';
import { OrderStatus, Role } from 'src/constants';
import { ProductVariant } from '../products/entities';
import { Address } from '../address/entities/address.entity';
import { QueryDto } from 'src/dto/query.dto';
import { ActorRole, ensureTransitionAllowed } from 'src/utils/order-status.rules';

@Injectable()
export class OrdersService {
  constructor(
    @InjectRepository(Order) private orderRepository: Repository<Order>,
    @InjectRepository(OrderItem) private orderItemRepository: Repository<OrderItem>,
    @InjectRepository(ProductVariant) private readonly variantRepo: Repository<ProductVariant>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async create(userId: number, createOrderDto: CreateOrderDto) {
    return await this.dataSource.manager.transaction(async (manager) => {
      const { addressId, note, items } = createOrderDto;
      const address = await manager.findOne(Address, { where: { user: { id: userId }, id: addressId }});
      if (!address) throw new HttpException('Address not found', HttpStatus.NOT_FOUND);
      console.log(address)
      const cart = await manager.findOne(Cart, { where: { user: { id: userId }}, relations: ['items', 'items.variant', 'user']});

      if (!cart || cart.items.length == 0) throw new HttpException('Cart is empty', HttpStatus.NOT_FOUND);

      const order = manager.create(Order, {
        user: cart.user,
        recipientName: address.recipientName,
        recipientPhone: address.recipientPhone,
        detailAddress: address.detailAddress,
        province: address.province,
        district: address.district,
        commune: address.commune,
        status: OrderStatus.PENDING,
        note: note,
        totalAmount: 0
      })
      await manager.save(order);

      let totalAmount = 0;
      for (const item of items) {
        const cartItem = cart.items.find(cartItem => cartItem.variant.id === item.variantId );
        if (!cartItem) throw new HttpException('Cart item not found', HttpStatus.NOT_FOUND);
        //Check tồn kho
        if (item.quantity > cartItem.variant.remaining) 
          throw new HttpException('Not enough quantity', HttpStatus.BAD_REQUEST);

        // Trừ tồn kho
        cartItem.variant.remaining -= item.quantity;
        await manager.save(ProductVariant, cartItem.variant);

        // Tạo order item
        const orderItem = manager.create(OrderItem, {
          order,
          variant: cartItem.variant,
          quantity: item.quantity,
          price: cartItem.variant.price
        })
        await manager.save(orderItem);
        totalAmount += item.quantity * orderItem.price;

        // Cập nhật cart
        if (item.quantity >= cartItem.quantity) await manager.remove(cartItem);
        else {
          cartItem.quantity -= item.quantity;
          await manager.save(CartItem, cartItem);
        }
      }

      order.totalAmount = totalAmount;
      await manager.save(order);
      return order;
    })
  }

  async getMyOrders(userId: number, query: QueryDto) {
    const { page, limit, sortBy = 'id', sortOrder = 'DESC' } = query;
    const [data, total] = await this.orderRepository.findAndCount({
      where: { user: { id: userId}},
      relations: ['items', 'items.variant'],
      ...(page && limit && { take: limit, skip: (page - 1) * limit }),
      order: { [sortBy]: sortOrder },
    });
    const response = { pagination: { total, page, limit }, data };
    console.log('data lay tu DB');
    return response;
  }

  async getOrderById(userId: number, id: number) {
    const order = await this.orderRepository.findOne({
      where: { user: { id: userId }, id },
      relations: ['items', 'items.variant'],
    });
    if (!order) throw new HttpException('Order not found', HttpStatus.NOT_FOUND);
    return order
  }

  async getAll(query: QueryDto){
    const { page, limit, search, sortBy = 'id', sortOrder = 'DESC' } = query;
    const [data, total] = await this.orderRepository.findAndCount({
      where: search
        ? [{ note: Like(`%${search}%`) }, { detailAddress: Like(`%${search}%`) }]
        : {},
      relations: ['items', 'items.variant', 'user'],
      ...(page && limit && { take: limit, skip: (page - 1) * limit }),
      order: { [sortBy]: sortOrder },
    });
    const response = {
      pagination: {
        total,
        page,
        limit,
      },
      data,
    };
    console.log('data lay tu DB');
    return response;
  }

  async updateStatus(orderId: number, next: OrderStatus, actor: {id: number, role: ActorRole, reason?: string }) {
    return this.dataSource.transaction(async (manager) => {
      const order = await manager.findOne(Order, { where: { id: orderId }, relations: ['items']});
      if (!order) throw new HttpException('Order not found', HttpStatus.NOT_FOUND);

      try {
        ensureTransitionAllowed(order.status, next, actor.role)
      }
      catch (e) {
        throw new HttpException(String(e), HttpStatus.BAD_REQUEST);
      }
      if (next === OrderStatus.CANCELED) {
        for (const it of order.items) {
          const variant = await manager.findOne(ProductVariant, { where: { id: it.variant.id } });
          if (variant) {
            variant.remaining = Number(variant.remaining) + Number(it.quantity);
            await manager.save(variant);
          }
        }
      }

      const prev = order.status;
      order.status = next;
      await manager.save(order);

      return { message: 'Order status updated', from: prev, to: next };
    });
  }
}
