import React, {Component} from 'react'
import './index.scss'
import {Link, withRouter} from 'react-router-dom'
import Header from '../../components/header'
// import { Button, Toast } from 'antd-mobile'
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import * as CollectAction from '../../redux/actions/collect';
import http from '../../http'
class Collect extends Component{
  goBack () {
    this.props.history.go(-1)
  }
  async componentWillMount() {
    const {fetchData} = this.props.actions
    fetchData()
  }

  render () {
    const {collect} = this.props
    return (
      <div id="collect">
        <Header clickLeft={this.goBack.bind(this)} title="easyLikeGoods"></Header>
        <div className="collectList"></div>
      </div>
    )
  }
}

const mapStateToProps = (state, props) => ({...state.collect})
const mapDispatchToProps = dispatch => ({actions: bindActionCreators(CollectAction, dispatch)})
export default withRouter(connect(mapStateToProps, mapDispatchToProps)(Collect))
