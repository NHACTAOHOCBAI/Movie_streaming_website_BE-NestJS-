import { IsEmail, IsEnum, IsOptional, IsString } from "class-validator"
import { Role } from "src/constants/role.enum";
export class CreateUserDto {
    @IsString()
    fullName: string

    @IsEmail()
    email: string

    @IsString()
    password: string

    @IsEnum(Role)// 👈 nếu không gửi thì sẽ mặc định là "user"
    role: Role;
}
