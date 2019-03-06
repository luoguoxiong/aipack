import React, {Component, Fragment} from 'react'
import Header from '../../components/header'
import {withRouter} from 'react-router-dom'
import {Button, Toast} from 'antd-mobile'
import './index.scss'
import http from '../../http'
import { connect } from 'react-redux';
import { bindActionCreators } from 'redux';
import * as CommonAction from '../../redux/actions/common';
class TopicCommentWrite extends Component{
  state = {
    id: null,
    areaMaxLen: 80,
    content: '',
    loading: false
  }
  componentDidMount () {
    const {match:{params:{id}}} = this.props
    this.setState({id})
  }
  goBack () {
    this.props.history.go(-1)
  }
  async submitArea () {
    const {id,content} = this.state
    this.setState({
      loading: true
    })
    const {errno, errmsg} = await http.postSetComment({content,typeId:1,valueId:id})
    if(errno === 0){
      Toast.success(errmsg, 1, () =>{
        this.setState({
          loading: false,
          content: ''
        })
        this.props.history.go(-1)
      })
    }else{
      Toast.fail(errmsg, .5,() => {
        if(errno === 401){
          this.setState({
            loading: false
          })
          this.props.actions.loginFailure()
        }
      })
    }
  }
  resetArea () {
    this.setState({
      content: ''
    })
  }
  getTextValue(e){
    this.setState({
      content:  e.currentTarget.value
    })
  }
  render () {
    const { areaMaxLen, content, loading} = this.state
    return (
      <Fragment>
        <Header clickLeft={this.goBack.bind(this)} title="填写留言"></Header>
        <div className="textAreaContent">
          <textarea className="inputArea" onChange={this.getTextValue.bind(this)} value={content} maxLength={areaMaxLen} autoFocus/>
          <span style={{color:content.length===areaMaxLen?'red':''}}>{content.length}/{areaMaxLen}</span>
        </div>
        <div className="buttons">
          <div>
            {content.length?<Button size="small" onClick={this.resetArea.bind(this)}>清空</Button>:null}
          </div>
          <div>
            <Button size="small" type="primary" loading={loading} disabled={loading} onClick={this.submitArea.bind(this)}>留言</Button>
          </div>
        </div>
      </Fragment>
    )
  }
}
const mapDispatchToProps = dispatch => ({actions: bindActionCreators(CommonAction, dispatch)})
export default withRouter(connect(null, mapDispatchToProps)(TopicCommentWrite))
