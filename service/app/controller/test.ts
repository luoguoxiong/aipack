import { Controller } from 'egg';
export default class ReportController extends Controller {
  public async index() {
    const { data } = this.ctx.query;
    console.log(JSON.parse(data));

    this.ctx.success();
  }
}
