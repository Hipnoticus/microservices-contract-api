import { Controller, Get, Param, Inject } from '@nestjs/common';
import { Sequelize, QueryTypes } from 'sequelize';
import { Logger } from '../../../shared/logger/Logger';

const logger = new Logger('TreatmentController');

@Controller('treatments')
export class TreatmentController {
  constructor(@Inject('DATABASE') private readonly db: Sequelize) {}

  @Get('customer/:customerId')
  async getTreatmentsByCustomer(@Param('customerId') customerId: string) {
    const treatments = await this.db.query(`
      SELECT t.ID, t.Customer, t.MainGoal, t.OrderNumber, t.SessionsNumber,
             t.PhaseDefined, t.PhaseDetected,
             COALESCE(tp.Name, 'Pré-Tratamento') as PhaseName,
             COALESCE(t.PhaseDefined, t.PhaseDetected, 1) as PhaseId,
             i.Name as GoalName,
             o.Total as OrderTotal, o.OrderStatusID,
             os.Name as OrderStatusName,
             (SELECT COUNT(*) FROM tbSessions s WHERE s.Treatment = t.ID AND s.Status = 1) as ConfirmedSessions,
             (SELECT COUNT(*) FROM tbSessions s WHERE s.Treatment = t.ID) as TotalSessions,
             (SELECT MIN(s.DateBegins) FROM tbSessions s WHERE s.Treatment = t.ID) as FirstSessionDate,
             (SELECT MAX(s.DateBegins) FROM tbSessions s WHERE s.Treatment = t.ID) as LastSessionDate
      FROM tbTreatments t
      LEFT JOIN tbTreatmentsPhases tp ON tp.ID = COALESCE(t.PhaseDefined, t.PhaseDetected, 1)
      LEFT JOIN tbIssues i ON i.ID = t.MainGoal
      LEFT JOIN tbOrders o ON o.ID = t.OrderNumber
      LEFT JOIN tbOrdersStatus os ON os.ID = o.OrderStatusID
      WHERE t.Customer = :customerId
        AND (
          -- Show treatments that have sessions
          EXISTS (SELECT 1 FROM tbSessions s WHERE s.Treatment = t.ID)
          -- Or the most recent treatment per MainGoal if none have sessions
          OR t.ID = (SELECT MAX(t2.ID) FROM tbTreatments t2 WHERE t2.Customer = t.Customer AND t2.MainGoal = t.MainGoal)
        )
      ORDER BY t.ID DESC
    `, {
      replacements: { customerId: parseInt(customerId, 10) },
      type: QueryTypes.SELECT,
    });

    return treatments;
  }

  @Get(':treatmentId/sessions')
  async getSessionsByTreatment(@Param('treatmentId') treatmentId: string) {
    const sessions = await this.db.query(`
      SELECT s.ID, s.ClientID, s.Treatment, s.DateBegins, s.DateEnds,
             s.Status, s.Value, s.PaymentType,
             ss.Name as StatusName
      FROM tbSessions s
      LEFT JOIN tbSessionsStatus ss ON ss.ID = s.Status
      WHERE s.Treatment = :treatmentId
      ORDER BY s.DateBegins ASC
    `, {
      replacements: { treatmentId: parseInt(treatmentId, 10) },
      type: QueryTypes.SELECT,
    });

    return sessions;
  }
}
