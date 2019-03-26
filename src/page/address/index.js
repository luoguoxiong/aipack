import React, {Component} from 'react'
// import {Toast} from 'antd-mobile'
import './index.scss'
import Header from '../../components/header'
// import { connect } from 'react-redux';
// import { bindActionCreators } from 'redux';
// import * as commonAction from '../../redux/actions/common';
import {withRouter} from "react-router-dom";
import delAddress from '../../static/img/del-address.png'
class Address extends Component{
  goBack () {
    this.props.history.go(-1)
  }
  render() {
    return (
      <div id="addressPage">
        <Header clickLeft={this.goBack.bind(this)} title="地址管理"/>
        <div className="addressList">
          <div className="addressItem">
            <div className="isChooseAddress"></div>
            <div className="addressMsg">
              <div className="concatName">
                罗国雄
              </div>
              <div className="addressDetail">
                <div className="concatPhone">15818264086</div>
                <div className="concatAddress">广东深，梅州市，五华县</div>
                <div className="concatAddress">山坑村9008h号</div>
              </div>
              <div className="deleteAddress">
                <img src={delAddress} alt="delAddress"/>
              </div>
            </div>
          </div>
        </div>
      </div>
    )

  }
}
export default withRouter(Address)
// const mapStateToProps = (state, props) => ({...state.common})
// const mapDispatchToProps = dispatch => ({actions: bindActionCreators(commonAction, dispatch)})
// export default withRouter(connect(mapStateToProps, mapDispatchToProps)(Mine))
