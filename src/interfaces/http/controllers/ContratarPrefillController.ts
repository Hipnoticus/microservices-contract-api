import { Controller, Get, HttpException, HttpStatus, Inject, Param } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { QueryTypes, Sequelize } from 'sequelize';

/**
 * Contratar prefill for /contratar?customerId=N links opened without logging in.
 *
 * Public at the gateway, so it answers ONLY for customers flagged tbCustomers.TestUser = 1 (the owner's test
 * accounts, e.g. 43). Any other id is 404, exactly like a missing one, so the endpoint cannot be used to read or
 * probe real customers. Logged-in customers and staff keep using CustomerAPI with their own token.
 */
@ApiTags('Contratar')
@Controller('contratar')
export class ContratarPrefillController {
  constructor(@Inject('DATABASE') private readonly db: Sequelize) {}

  @Get('prefill/:customerId')
  async prefill(@Param('customerId') raw: string) {
    const id = /^\d{1,9}$/.test(raw || '') ? parseInt(raw, 10) : 0;
    const rows = id ? await this.db.query<any>(`
      SELECT c.ID AS id, c.CallName AS callName, c.FirstName AS firstName, c.LastName AS lastName, c.Email AS email,
             c.CPFCNPJ AS cpf, c.PhoneNumber AS phoneNumber, c.Sex AS sexo,
             CONVERT(varchar(10), c.DateOfBirth, 126) AS dataNascimento
      FROM tbCustomers c
      WHERE c.ID = :id AND ISNULL(c.TestUser, 0) = 1 AND ISNULL(c.Blocked, 0) = 0`,
      { replacements: { id }, type: QueryTypes.SELECT }) : [];
    if (!rows.length) throw new HttpException({ error: 'Não encontrado.' }, HttpStatus.NOT_FOUND);
    const address = await this.db.query<any>(`
      SELECT TOP 1 Address AS address, Number AS number, Address2 AS address2, Town AS town, City AS city,
             State AS state, Zip AS zip
      FROM tbCustomersAddresses WHERE CustomerID = :id AND ISNULL(Blocked, 0) = 0
      ORDER BY ISNULL(MainAddress, 0) DESC, ID DESC`,
      { replacements: { id }, type: QueryTypes.SELECT });
    return { customer: rows[0], address: address[0] || null };
  }
}
