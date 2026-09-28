router.get(
  '/tickets/:id',
  authenticate,
  userLimiter,
  validateParams(uuidParamSchema),
  requirePolicy('ticket:view', async (req) => {
    const { data: ticket } = await userDb(req)
      .from('support_tickets')
      .select('id, user_id')
      .eq('id', req.params.id)
      .maybeSingle();

    return { ticket };
  }),
  async (req, res) => {
    const ticketId = req.params.id;

    try {
      const { data: ticket, error } = await userDb(req)
        .from('support_tickets')
        .select(TICKET_DETAIL_COLUMNS)
        .eq('id', ticketId)
        .maybeSingle();

      if (error) {
        return res.status(500).json({
          error: 'Failed to fetch support ticket.',
          details: error.message,
        });
      }

      if (!ticket) {
        return res.status(404).json({
          error: 'Support ticket not found.',
        });
      }

      res.json(ticket);
    } catch (err) {
      logger.error(
        '[SupportRoutes] Error:',
        err?.message || err
      );

      res.status(500).json({
        error: err?.message || 'Internal Server Error',
      });
    }
  }
);


